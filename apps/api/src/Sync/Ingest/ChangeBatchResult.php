<?php

declare(strict_types=1);

namespace App\Sync\Ingest;

final readonly class ChangeBatchResult
{
    public function __construct(
        public int $updated,
        /** Locations removed from this folder. */
        public int $removed,
        /** Flag changes for messages that were not ingested yet; the worker should send them as new messages. */
        public int $unknown,
        /**
         * Messages that are in no folder anymore. They are deleted once no copy showed up elsewhere within
         * {@see MessageJanitor::GRACE}.
         */
        public int $deleted,
        /**
         * The remote uids behind $unknown, so a worker that sends flags first (Gmail, Microsoft Graph) downloads only
         * the messages the API does not have yet.
         *
         * @var list<string>
         */
        public array $unknownUids = [],
    ) {
    }
}
