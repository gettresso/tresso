<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\Input\CheckMailAccount;
use App\ApiResource\MailAccountCheck;
use App\Mail\Check\CheckLock;
use App\Mail\Check\ConnectionCheck;
use App\Mail\Check\MailConnectionChecker;
use App\Repository\MailAccountRepository;
use App\Security\CurrentUser;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * @implements ProcessorInterface<CheckMailAccount, MailAccountCheck>
 */
final readonly class MailAccountCheckProcessor implements ProcessorInterface
{
    public function __construct(
        private MailConnectionChecker $checker,
        private CheckLock $lock,
        private MailAccountRepository $accounts,
        private CurrentUser $currentUser,
        #[Autowire(service: 'limiter.mail_account_check')]
        private RateLimiterFactoryInterface $limiter,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): MailAccountCheck
    {
        $owner = $this->currentUser->get();
        $emailAddress = mb_strtolower(trim($data->emailAddress));
        // Said before anything is tried, as creating the account would.
        if ($this->accounts->existsForOwner($owner, $emailAddress)) {
            throw new ValidationException(new ConstraintViolationList([
                new ConstraintViolation('You already connected this email address.', null, [], $data, 'emailAddress', $data->emailAddress),
            ]));
        }

        // Every check makes the API connect to a server the user named; a limit keeps that from becoming a port scanner.
        $limit = $this->limiter->create($owner->getId()->toRfc4122())->consume();
        if (!$limit->isAccepted()) {
            throw new TooManyRequestsHttpException($limit->getRetryAfter()->getTimestamp() - time(), 'Too many connection checks. Wait a few minutes, then try again.');
        }

        $imap = $data->imap ?? throw new \LogicException('Validation guarantees IMAP settings.');
        $smtp = $data->smtp ?? throw new \LogicException('Validation guarantees SMTP settings.');
        // Both servers within the checker's total budget, with room for the answer; more than PHP's default limit.
        set_time_limit(MailConnectionChecker::TOTAL + 15);
        $result = $this->lock->run($owner->getId()->toRfc4122(), fn (): ConnectionCheck => $this->checker->check($imap, $smtp, $data->username, $data->password))
            ?? throw new TooManyRequestsHttpException(MailConnectionChecker::TOTAL, 'Another connection check of yours is still running. Wait for it, then try again.');

        return new MailAccountCheck($emailAddress, $result->imap->value, $result->smtp->value, $result->folders, $result->detail);
    }
}
