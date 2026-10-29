<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20261029015809 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Billing: a subscription per organization, with a free trial for every existing one, and handled Stripe events';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TABLE billing_stripe_event (id VARCHAR(255) NOT NULL, type VARCHAR(120) NOT NULL, received_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX IDX_A45B28FF6D4F7F99 ON billing_stripe_event (received_at)');
        $this->addSql('CREATE TABLE billing_subscription (id UUID NOT NULL, status VARCHAR(24) NOT NULL, trial_ends_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, stripe_customer_id VARCHAR(255) DEFAULT NULL, stripe_subscription_id VARCHAR(255) DEFAULT NULL, seats INT DEFAULT 0 NOT NULL, current_period_end TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, updated_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, organization_id UUID NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_16912F26708DC647 ON billing_subscription (stripe_customer_id)');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_16912F26B5DBB761 ON billing_subscription (stripe_subscription_id)');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_16912F2632C8A3DE ON billing_subscription (organization_id)');
        $this->addSql('ALTER TABLE billing_subscription ADD CONSTRAINT FK_16912F2632C8A3DE FOREIGN KEY (organization_id) REFERENCES organization (id) ON DELETE CASCADE NOT DEFERRABLE');

        // Every organization gets its trial from now (UTC, as every time is stored). A server that turns billing on later
        // runs app:billing:restart-trials then, so nobody is blocked at once.
        $this->addSql("INSERT INTO billing_subscription (id, organization_id, status, trial_ends_at, seats, updated_at)
            SELECT uuidv7(), id, 'trial', (now() AT TIME ZONE 'UTC')::timestamp(0) + INTERVAL '14 days', 0, (now() AT TIME ZONE 'UTC')::timestamp(0) FROM organization");
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('ALTER TABLE billing_subscription DROP CONSTRAINT FK_16912F2632C8A3DE');
        $this->addSql('DROP TABLE billing_stripe_event');
        $this->addSql('DROP TABLE billing_subscription');
    }
}
