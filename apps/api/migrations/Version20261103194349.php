<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20261103194349 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Apps that are not ours: clients that registered themselves (RFC 7591), and what each user allowed each app';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TABLE oauth_consent (id UUID NOT NULL, scopes JSON NOT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, last_used_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, user_id UUID NOT NULL, client_id VARCHAR(32) NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX IDX_7014A76519EB6921 ON oauth_consent (client_id)');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_7014A765A76ED39519EB6921 ON oauth_consent (user_id, client_id)');
        $this->addSql('CREATE INDEX IDX_7014A765A76ED395 ON oauth_consent (user_id)');
        $this->addSql('CREATE TABLE registered_client (created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, last_used_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, client_id VARCHAR(32) NOT NULL, PRIMARY KEY (client_id))');
        $this->addSql('CREATE INDEX IDX_D3C856148B8E8428 ON registered_client (created_at)');
        $this->addSql('ALTER TABLE oauth_consent ADD CONSTRAINT FK_7014A765A76ED395 FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE oauth_consent ADD CONSTRAINT FK_7014A76519EB6921 FOREIGN KEY (client_id) REFERENCES oauth2_client (identifier) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE registered_client ADD CONSTRAINT FK_D3C8561419EB6921 FOREIGN KEY (client_id) REFERENCES oauth2_client (identifier) ON DELETE CASCADE NOT DEFERRABLE');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('ALTER TABLE oauth_consent DROP CONSTRAINT FK_7014A765A76ED395');
        $this->addSql('ALTER TABLE oauth_consent DROP CONSTRAINT FK_7014A76519EB6921');
        $this->addSql('ALTER TABLE registered_client DROP CONSTRAINT FK_D3C8561419EB6921');
        $this->addSql('DROP TABLE oauth_consent');
        $this->addSql('DROP TABLE registered_client');
    }
}
