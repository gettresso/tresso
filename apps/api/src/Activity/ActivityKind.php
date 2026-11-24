<?php

declare(strict_types=1);

namespace App\Activity;

use App\Mcp\Tool\ToolEffect;

/**
 * What an action did, as the activity log shows it: it read, it changed something in Tresso, or it sent mail or a
 * WhatsApp message to other people.
 */
enum ActivityKind: string
{
    case Read = 'read';
    case Change = 'change';
    case Send = 'send';

    public function label(): string
    {
        return match ($this) {
            self::Read => 'Read',
            self::Change => 'Change',
            self::Send => 'Send',
        };
    }

    /** The verb of "Nothing was ..." after a refusal. */
    public function nothingWas(): string
    {
        return match ($this) {
            self::Read => 'read',
            self::Change => 'changed',
            self::Send => 'sent',
        };
    }

    public static function ofTool(ToolEffect $effect): self
    {
        return match ($effect) {
            ToolEffect::Read => self::Read,
            ToolEffect::Create, ToolEffect::Update, ToolEffect::Delete => self::Change,
            ToolEffect::Send => self::Send,
        };
    }
}
