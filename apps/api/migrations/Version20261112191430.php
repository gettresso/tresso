<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * A WhatsApp reply's claim: the device that claimed it and the claim's secret, which its result must name. Two nullable
 * columns without a default on a new table: no rewrite, no long lock.
 */
final class Version20261112191430 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Chat reply: the claiming device and the claim token';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE chat_outgoing ADD claimed_by UUID DEFAULT NULL');
        $this->addSql('ALTER TABLE chat_outgoing ADD claim_token VARCHAR(43) DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE chat_outgoing DROP claimed_by');
        $this->addSql('ALTER TABLE chat_outgoing DROP claim_token');
    }
}
