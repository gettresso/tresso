<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * WhatsApp files through the relay: where a message's file stands (on the Mac, asked for, stored, failed) and the
 * stored file's key and scan; the file a reply carries; files uploaded for a reply before it is queued. Messages that
 * carry a file start on the Mac (`remote`).
 */
final class Version20261113153000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'WhatsApp files: the state of a message file, a reply file, and uploads for replies';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE chat_upload (id UUID NOT NULL, object_key VARCHAR(255) NOT NULL, key_version INT NOT NULL, sha256 VARCHAR(64) NOT NULL, size BIGINT NOT NULL, content_type VARCHAR(255) NOT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, chat_id UUID NOT NULL, chat_account_id UUID NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX chat_upload_chat ON chat_upload (chat_id)');
        $this->addSql('CREATE INDEX chat_upload_created ON chat_upload (created_at)');
        $this->addSql('CREATE INDEX chat_upload_sha ON chat_upload (sha256)');
        $this->addSql('CREATE INDEX IDX_7061D13E5C9A1A1C ON chat_upload (chat_account_id)');
        $this->addSql('ALTER TABLE chat_upload ADD CONSTRAINT FK_7061D13E1A9A7125 FOREIGN KEY (chat_id) REFERENCES chat (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE chat_upload ADD CONSTRAINT FK_7061D13E5C9A1A1C FOREIGN KEY (chat_account_id) REFERENCES chat_account (id) ON DELETE CASCADE NOT DEFERRABLE');
        $this->addSql('ALTER TABLE chat_outgoing ADD sealed_file_name TEXT DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_outgoing ADD file_size BIGINT DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_outgoing ADD file_object_key VARCHAR(255) DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_outgoing ADD file_key_version INT DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_outgoing ADD file_sha256 VARCHAR(64) DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_outgoing ADD file_content_type VARCHAR(255) DEFAULT NULL');
        $this->addSql('CREATE INDEX chat_outgoing_file_sha ON chat_outgoing (file_sha256)');
        $this->addSql('ALTER TABLE chat_message ADD media_state VARCHAR(16) DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_error VARCHAR(16) DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_requested_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_claimed_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_object_key VARCHAR(255) DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_key_version INT DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_sha256 VARCHAR(64) DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_stored_size BIGINT DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_content_type VARCHAR(255) DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_scan_status VARCHAR(16) DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_scan_failure VARCHAR(16) DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_message ADD media_scan_requested_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL');
        // Every file the server knows of so far is on the Mac only. Not a change for clients: they read a file without a
        // state as one on the Mac.
        $this->addSql("UPDATE chat_message SET media_state = 'remote' WHERE media_kind IS NOT NULL");
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE chat_upload DROP CONSTRAINT FK_7061D13E1A9A7125');
        $this->addSql('ALTER TABLE chat_upload DROP CONSTRAINT FK_7061D13E5C9A1A1C');
        $this->addSql('DROP TABLE chat_upload');
        $this->addSql('DROP INDEX chat_outgoing_file_sha');
        $this->addSql('ALTER TABLE chat_outgoing DROP sealed_file_name');
        $this->addSql('ALTER TABLE chat_outgoing DROP file_size');
        $this->addSql('ALTER TABLE chat_outgoing DROP file_object_key');
        $this->addSql('ALTER TABLE chat_outgoing DROP file_key_version');
        $this->addSql('ALTER TABLE chat_outgoing DROP file_sha256');
        $this->addSql('ALTER TABLE chat_outgoing DROP file_content_type');
        $this->addSql('ALTER TABLE chat_message DROP media_state');
        $this->addSql('ALTER TABLE chat_message DROP media_error');
        $this->addSql('ALTER TABLE chat_message DROP media_requested_at');
        $this->addSql('ALTER TABLE chat_message DROP media_claimed_at');
        $this->addSql('ALTER TABLE chat_message DROP media_object_key');
        $this->addSql('ALTER TABLE chat_message DROP media_key_version');
        $this->addSql('ALTER TABLE chat_message DROP media_sha256');
        $this->addSql('ALTER TABLE chat_message DROP media_stored_size');
        $this->addSql('ALTER TABLE chat_message DROP media_content_type');
        $this->addSql('ALTER TABLE chat_message DROP media_scan_status');
        $this->addSql('ALTER TABLE chat_message DROP media_scan_failure');
        $this->addSql('ALTER TABLE chat_message DROP media_scan_requested_at');
    }
}
