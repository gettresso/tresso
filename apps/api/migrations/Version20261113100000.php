<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Indexes for reading WhatsApp without the delta (App\Chat\ChatReader): the chats of an account by their newest
 * message, and an account's messages by time, which a search reads newest first. Built without blocking reads and
 * writes of `chat_message`, which can be large: `CREATE INDEX CONCURRENTLY` cannot run in a transaction, so this
 * migration runs without one. A build that is cut off leaves an invalid index behind; the migration is then not recorded
 * as done, and its next run drops it before building it again.
 */
final class Version20261113100000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Indexes of WhatsApp chats by newest message and of messages by account and time, built concurrently';
    }

    public function isTransactional(): bool
    {
        return false;
    }

    public function up(Schema $schema): void
    {
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS chat_last_message');
        $this->addSql('CREATE INDEX CONCURRENTLY chat_last_message ON chat (chat_account_id, last_message_at)');
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS chat_message_account_sent');
        $this->addSql('CREATE INDEX CONCURRENTLY chat_message_account_sent ON chat_message (chat_account_id, sent_at)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS chat_message_account_sent');
        $this->addSql('DROP INDEX CONCURRENTLY IF EXISTS chat_last_message');
    }
}
