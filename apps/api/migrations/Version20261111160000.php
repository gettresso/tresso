<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Notification email addresses that need a confirmation link. Existing choices get the proof they have now: the
 * sign-in address, or a Google or Microsoft account's address as its grant confirmed it (a Microsoft account only
 * when it synced), the same rule as App\Notification\NotificationAddresses. Any other stored address (an IMAP
 * account's, say) gets none, so it is moved to pending with a confirmation link at its first use.
 */
final class Version20261111160000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Notification email addresses: how each was proven, when one was confirmed by link, and one that waits';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE notification_preferences ADD email_address_proof VARCHAR(16) DEFAULT NULL');
        $this->addSql('ALTER TABLE notification_preferences ADD email_address_confirmed_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL');
        $this->addSql('ALTER TABLE notification_preferences ADD pending_email_address VARCHAR(320) DEFAULT NULL');
        $this->addSql('ALTER TABLE notification_preferences ADD pending_email_sent_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL');
        $this->addSql("UPDATE notification_preferences p SET email_address_proof = 'sign_in'
            FROM app_user u WHERE u.id = p.user_id AND p.email_address IS NOT NULL AND LOWER(p.email_address) = LOWER(u.email)");
        $this->addSql("UPDATE notification_preferences p SET email_address_proof = 'provider'
            WHERE p.email_address IS NOT NULL AND p.email_address_proof IS NULL AND EXISTS (
                SELECT 1 FROM mail_account a JOIN provider_grant g ON g.id = a.provider_grant_id
                WHERE a.owner_id = p.user_id AND g.owner_id = p.user_id
                  AND LOWER(a.email_address) = LOWER(p.email_address) AND LOWER(a.email_address) = LOWER(g.email_address)
                  AND (g.provider <> 'microsoft' OR a.last_synced_at IS NOT NULL))");
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE notification_preferences DROP email_address_proof');
        $this->addSql('ALTER TABLE notification_preferences DROP email_address_confirmed_at');
        $this->addSql('ALTER TABLE notification_preferences DROP pending_email_address');
        $this->addSql('ALTER TABLE notification_preferences DROP pending_email_sent_at');
    }
}
