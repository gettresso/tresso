<?php

declare(strict_types=1);

namespace App\Command;

use App\Enum\ScanStatus;
use App\Repository\UserRepository;
use App\Scan\ScanAttachment;
use App\Scan\ScanTarget;
use Doctrine\DBAL\ArrayParameterType;
use Doctrine\DBAL\Connection;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Attribute\Option;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Style\SymfonyStyle;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Stamp\TransportNamesStamp;

/**
 * Queues attachments (received, and attached to drafts) and WhatsApp files the relay brought for a fresh scan that skips the verdict cache: for the given
 * users, or with --all for everyone, for example after a signature update or once clamd is back after scans failed.
 * Each content is queued once, and its verdict then applies to every attachment with that content.
 *
 * It walks the contents in hash order, a batch at a time, and prints where it is, so an interrupted run continues with
 * --after. Rescans go to their own, lower priority transport (`scan_rescan`), so new mail is scanned first. Downloads
 * keep their current verdict until the new one is in: clean files stay available, quarantined ones stay blocked
 * unless the new scan clears them.
 */
#[AsCommand(name: 'app:attachments:rescan', description: 'Scan attachments again for some users or everyone')]
final readonly class RescanAttachmentsCommand
{
    public const string TRANSPORT = 'scan_rescan';

    private const int BATCH = 1000;

    public function __construct(
        private UserRepository $users,
        private Connection $connection,
        private MessageBusInterface $bus,
    ) {
    }

    /**
     * @param list<string> $user
     * @param list<string> $status
     */
    public function __invoke(
        SymfonyStyle $io,
        #[Option('Email address of a user whose attachments to rescan; repeat for several users')]
        array $user = [],
        #[Option('Rescan the attachments of every user')]
        bool $all = false,
        #[Option('Only rescan attachments with this scan status (pending, clean, infected, failed); repeat for several')]
        array $status = [],
        #[Option('Continue after this content hash, as printed by an interrupted run')]
        ?string $after = null,
    ): int {
        if ($all === ([] !== $user)) {
            $io->error('Pass --user=<email> (once or more) or --all.');

            return Command::INVALID;
        }
        if (null !== $after && 1 !== preg_match('/^[0-9a-f]{64}$/', $after)) {
            $io->error('--after takes a content hash (64 hex characters) as printed by an earlier run.');

            return Command::INVALID;
        }

        $statuses = [];
        foreach ($status as $value) {
            $parsed = ScanStatus::tryFrom($value);
            if (null === $parsed) {
                $io->error(\sprintf('Unknown scan status "%s"; use pending, clean, infected or failed.', $value));

                return Command::INVALID;
            }
            $statuses[] = $parsed->value;
        }

        $owners = $all ? null : $this->ownerIds($user, $io);
        if ([] === $owners) {
            return Command::FAILURE;
        }

        $queued = 0;
        $cursor = $after ?? '';
        while ([] !== $batch = $this->batch($owners, $statuses, $cursor)) {
            foreach ($batch as $row) {
                $this->bus->dispatch(new ScanAttachment($row['id'], ScanTarget::from($row['target']), rescan: true), [new TransportNamesStamp([self::TRANSPORT])]);
                $cursor = $row['sha256'];
                ++$queued;
            }
            $io->writeln(\sprintf('Queued %d so far, up to %s', $queued, $cursor));
        }

        $io->success(\sprintf('Queued %d attachment %s for a new scan.', $queued, 1 === $queued ? 'content' : 'contents'));

        return Command::SUCCESS;
    }

    /**
     * The next contents after the cursor, one attachment each.
     *
     * @param list<string>|null $ownerIds null for everyone
     * @param list<string>      $statuses empty for every status
     *
     * @return list<array{id: string, target: string, sha256: string}>
     */
    private function batch(?array $ownerIds, array $statuses, string $cursor): array
    {
        $received = ['a.sha256 > :cursor'];
        $drafts = ['d.sha256 > :cursor'];
        $chats = ['cm.media_sha256 > :cursor'];
        $parameters = ['cursor' => $cursor, 'batch' => self::BATCH];
        $types = [];
        if (null !== $ownerIds) {
            $received[] = 'm.owner_id IN (:owners)';
            $drafts[] = 'dr.owner_id IN (:owners)';
            $chats[] = 'ca.owner_id IN (:owners)';
            $parameters['owners'] = $ownerIds;
            $types['owners'] = ArrayParameterType::STRING;
        }
        if ([] !== $statuses) {
            $received[] = 'a.scan_status IN (:statuses)';
            $drafts[] = 'd.scan_status IN (:statuses)';
            $chats[] = 'cm.media_scan_status IN (:statuses)';
            $parameters['statuses'] = $statuses;
            $types['statuses'] = ArrayParameterType::STRING;
        }

        /** @var list<array{id: string, target: string, sha256: string}> */
        return $this->connection->fetchAllAssociative(
            "SELECT DISTINCT ON (sha256) id, target, sha256 FROM (
                (SELECT DISTINCT ON (a.sha256) a.id, 'received' AS target, a.sha256 FROM attachment a JOIN mail_account m ON m.id = a.mail_account_id
                 WHERE ".implode(' AND ', $received).' ORDER BY a.sha256, a.id LIMIT :batch)
                UNION ALL
                (SELECT DISTINCT ON (d.sha256) d.id, \'draft\' AS target, d.sha256 FROM draft_attachment d JOIN draft dr ON dr.id = d.draft_id
                 WHERE '.implode(' AND ', $drafts).' ORDER BY d.sha256, d.id LIMIT :batch)
                UNION ALL
                (SELECT DISTINCT ON (cm.media_sha256) cm.id, \'chat\' AS target, cm.media_sha256 AS sha256 FROM chat_message cm JOIN chat_account ca ON ca.id = cm.chat_account_id
                 WHERE '.implode(' AND ', $chats).' ORDER BY cm.media_sha256, cm.id LIMIT :batch)
             ) contents ORDER BY sha256, target DESC, id LIMIT :batch',
            $parameters,
            $types,
        );
    }

    /**
     * @param list<string> $emails
     *
     * @return list<string> user ids; empty when an address belongs to nobody
     */
    private function ownerIds(array $emails, SymfonyStyle $io): array
    {
        $ids = [];
        foreach ($emails as $email) {
            $found = $this->users->findOneBy(['email' => mb_strtolower($email)]);
            if (null === $found) {
                $io->error(\sprintf('No user with the email address %s.', $email));

                return [];
            }
            $ids[] = $found->getId()->toRfc4122();
        }

        return $ids;
    }
}
