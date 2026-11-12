<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20261112141837 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'WhatsApp chats relayed to the server: chat accounts, chats, chat messages and replies, with what they say and who they are with sealed';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TABLE chat (id UUID NOT NULL, change_seq BIGINT DEFAULT 0 NOT NULL, jid_fingerprint VARCHAR(64) NOT NULL, sealed_jid TEXT NOT NULL, sealed_name TEXT DEFAULT NULL, kind VARCHAR(16) NOT NULL, last_message_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, read_through TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, archived_through TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, left_out BOOLEAN DEFAULT false NOT NULL, chat_account_id UUID NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX IDX_659DF2AA5C9A1A1C475BB34E ON chat (chat_account_id, change_seq)');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_659DF2AA5C9A1A1CC740FA68 ON chat (chat_account_id, jid_fingerprint)');
        $this->addSql('CREATE INDEX IDX_659DF2AA5C9A1A1C ON chat (chat_account_id)');
        $this->addSql('CREATE TABLE chat_account (id UUID NOT NULL, change_seq BIGINT DEFAULT 0 NOT NULL, channel VARCHAR(16) NOT NULL, sealed_address TEXT DEFAULT NULL, sealed_display_name TEXT DEFAULT NULL, relay_device_id UUID NOT NULL, relay_device_name VARCHAR(255) NOT NULL, relay_seen_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, relay_online BOOLEAN NOT NULL, relay_offline_since TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, bridge_state VARCHAR(16) NOT NULL, link_state VARCHAR(16) NOT NULL, linked_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, loopback_only BOOLEAN DEFAULT NULL, include_groups BOOLEAN DEFAULT true NOT NULL, notify BOOLEAN DEFAULT false NOT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, owner_id UUID NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX IDX_31389ACD7E3C61F9475BB34E ON chat_account (owner_id, change_seq)');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_31389ACD7E3C61F9A2F98E47 ON chat_account (owner_id, channel)');
        $this->addSql('CREATE INDEX IDX_31389ACD7E3C61F9 ON chat_account (owner_id)');
        $this->addSql('CREATE TABLE chat_message (id UUID NOT NULL, change_seq BIGINT DEFAULT 0 NOT NULL, wa_fingerprint VARCHAR(64) NOT NULL, from_me BOOLEAN NOT NULL, sent_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, sealed_wa_id TEXT NOT NULL, sealed_sender TEXT DEFAULT NULL, sealed_text TEXT NOT NULL, media_kind VARCHAR(16) DEFAULT NULL, sealed_media_name TEXT DEFAULT NULL, media_size BIGINT DEFAULT NULL, chat_id UUID NOT NULL, chat_account_id UUID NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX IDX_FAB3FC165C9A1A1C475BB34E ON chat_message (chat_account_id, change_seq)');
        $this->addSql('CREATE INDEX IDX_FAB3FC161A9A712596E4F388 ON chat_message (chat_id, sent_at)');
        $this->addSql('CREATE UNIQUE INDEX UNIQ_FAB3FC161A9A7125541F6242 ON chat_message (chat_id, wa_fingerprint)');
        $this->addSql('CREATE INDEX IDX_FAB3FC161A9A7125 ON chat_message (chat_id)');
        $this->addSql('CREATE INDEX IDX_FAB3FC165C9A1A1C ON chat_message (chat_account_id)');
        $this->addSql('CREATE TABLE chat_outgoing (id UUID NOT NULL, change_seq BIGINT DEFAULT 0 NOT NULL, sealed_text TEXT NOT NULL, status VARCHAR(16) NOT NULL, error VARCHAR(64) DEFAULT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, claimed_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, sent_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, chat_id UUID NOT NULL, chat_account_id UUID NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX IDX_51D104605C9A1A1C475BB34E ON chat_outgoing (chat_account_id, change_seq)');
        $this->addSql('CREATE INDEX IDX_51D104605C9A1A1C7B00651CBF396750 ON chat_outgoing (chat_account_id, status, id)');
        $this->addSql('CREATE INDEX IDX_51D104601A9A7125 ON chat_outgoing (chat_id)');
        $this->addSql('CREATE INDEX IDX_51D104605C9A1A1C ON chat_outgoing (chat_account_id)');
        $this->addSql('ALTER TABLE chat ADD CONSTRAINT FK_659DF2AA5C9A1A1C FOREIGN KEY (chat_account_id) REFERENCES chat_account (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE chat_account ADD CONSTRAINT FK_31389ACD7E3C61F9 FOREIGN KEY (owner_id) REFERENCES app_user (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE chat_message ADD CONSTRAINT FK_FAB3FC161A9A7125 FOREIGN KEY (chat_id) REFERENCES chat (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE chat_message ADD CONSTRAINT FK_FAB3FC165C9A1A1C FOREIGN KEY (chat_account_id) REFERENCES chat_account (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE chat_outgoing ADD CONSTRAINT FK_51D104601A9A7125 FOREIGN KEY (chat_id) REFERENCES chat (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE chat_outgoing ADD CONSTRAINT FK_51D104605C9A1A1C FOREIGN KEY (chat_account_id) REFERENCES chat_account (id) ON DELETE CASCADE NOT DEFERRABLE');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('ALTER TABLE chat DROP CONSTRAINT FK_659DF2AA5C9A1A1C');
        $this->addSql('ALTER TABLE chat_account DROP CONSTRAINT FK_31389ACD7E3C61F9');
        $this->addSql('ALTER TABLE chat_message DROP CONSTRAINT FK_FAB3FC161A9A7125');
        $this->addSql('ALTER TABLE chat_message DROP CONSTRAINT FK_FAB3FC165C9A1A1C');
        $this->addSql('ALTER TABLE chat_outgoing DROP CONSTRAINT FK_51D104601A9A7125');
        $this->addSql('ALTER TABLE chat_outgoing DROP CONSTRAINT FK_51D104605C9A1A1C');
        $this->addSql('DROP TABLE chat');
        $this->addSql('DROP TABLE chat_account');
        $this->addSql('DROP TABLE chat_message');
        $this->addSql('DROP TABLE chat_outgoing');
    }
}
