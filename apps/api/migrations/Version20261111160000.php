<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20261111160000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Notification email addresses that need a confirmation link: when one was confirmed, and one that waits';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE notification_preferences ADD email_address_confirmed_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL');
        $this->addSql('ALTER TABLE notification_preferences ADD pending_email_address VARCHAR(320) DEFAULT NULL');
        $this->addSql('ALTER TABLE notification_preferences ADD pending_email_sent_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE notification_preferences DROP email_address_confirmed_at');
        $this->addSql('ALTER TABLE notification_preferences DROP pending_email_address');
        $this->addSql('ALTER TABLE notification_preferences DROP pending_email_sent_at');
    }
}
