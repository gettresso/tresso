<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * The activity log of apps that are not ours (`app_activity`): one row per MCP tool call or API request, without
 * content, removed with the user and after 90 days. And the permissions a user switched off for a connected app
 * (`oauth_consent.disabled_scopes`), apart from those granted on the consent screen; none are switched off at first.
 */
final class Version20261124170000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'App activity log, and permissions switched off per connected app';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE app_activity (id UUID NOT NULL, occurred_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, app_type VARCHAR(8) NOT NULL, app_id VARCHAR(80) NOT NULL, channel VARCHAR(8) NOT NULL, method VARCHAR(8) DEFAULT NULL, action VARCHAR(200) NOT NULL, kind VARCHAR(8) NOT NULL, result VARCHAR(8) NOT NULL, reason VARCHAR(32) DEFAULT NULL, duration_ms INT NOT NULL, scopes JSON NOT NULL, object_type VARCHAR(64) DEFAULT NULL, object_list BOOLEAN DEFAULT false NOT NULL, object_id VARCHAR(100) DEFAULT NULL, owner_id UUID NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX app_activity_owner_time ON app_activity (owner_id, occurred_at, id)');
        $this->addSql('CREATE INDEX app_activity_owner_app_time ON app_activity (owner_id, app_type, app_id, occurred_at)');
        $this->addSql('CREATE INDEX app_activity_owner_kind_time ON app_activity (owner_id, kind, occurred_at)');
        $this->addSql('CREATE INDEX app_activity_owner_result_time ON app_activity (owner_id, result, occurred_at)');
        $this->addSql('CREATE INDEX app_activity_time ON app_activity (occurred_at)');
        $this->addSql('CREATE INDEX IDX_A4F469F77E3C61F9 ON app_activity (owner_id)');
        $this->addSql('ALTER TABLE app_activity ADD CONSTRAINT FK_A4F469F77E3C61F9 FOREIGN KEY (owner_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE oauth_consent ADD disabled_scopes JSON DEFAULT \'[]\' NOT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE app_activity DROP CONSTRAINT FK_A4F469F77E3C61F9');
        $this->addSql('DROP TABLE app_activity');
        $this->addSql('ALTER TABLE oauth_consent DROP disabled_scopes');
    }
}
