<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20261028232603 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Organizations with their members, and a personal organization owned by every existing user';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TABLE organization (id UUID NOT NULL, name VARCHAR(120) DEFAULT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, personal_owner_id UUID DEFAULT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_C1EE637CD203BFB0 ON organization (personal_owner_id)');
        // A team has a name and no personal owner; a personal organization goes by its owner's name.
        $this->addSql('ALTER TABLE organization ADD CONSTRAINT organization_team_or_personal CHECK ((personal_owner_id IS NULL) <> (name IS NULL))');
        $this->addSql('CREATE TABLE organization_member (id UUID NOT NULL, role VARCHAR(16) NOT NULL, joined_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, organization_id UUID NOT NULL, user_id UUID NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX IDX_756A2A8DA76ED395 ON organization_member (user_id)');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_756A2A8D32C8A3DEA76ED395 ON organization_member (organization_id, user_id)');
        $this->addSql('CREATE INDEX IDX_756A2A8D32C8A3DE ON organization_member (organization_id)');
        $this->addSql('ALTER TABLE organization ADD CONSTRAINT FK_C1EE637CD203BFB0 FOREIGN KEY (personal_owner_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE organization_member ADD CONSTRAINT FK_756A2A8D32C8A3DE FOREIGN KEY (organization_id) REFERENCES organization (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE organization_member ADD CONSTRAINT FK_756A2A8DA76ED395 FOREIGN KEY (user_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE');

        // Every user owns a personal organization from the start, also those made before organizations existed.
        $this->addSql('INSERT INTO organization (id, name, created_at, personal_owner_id) SELECT uuidv7(), NULL, created_at, id FROM app_user');
        $this->addSql("INSERT INTO organization_member (id, role, joined_at, organization_id, user_id) SELECT uuidv7(), 'owner', created_at, id, personal_owner_id FROM organization");
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('ALTER TABLE organization DROP CONSTRAINT FK_C1EE637CD203BFB0');
        $this->addSql('ALTER TABLE organization_member DROP CONSTRAINT FK_756A2A8D32C8A3DE');
        $this->addSql('ALTER TABLE organization_member DROP CONSTRAINT FK_756A2A8DA76ED395');
        $this->addSql('DROP TABLE organization');
        $this->addSql('DROP TABLE organization_member');
    }
}
