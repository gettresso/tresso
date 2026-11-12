<?php

declare(strict_types=1);

namespace App\Enum;

/** The messaging service a chat account reaches, through a bridge on the user's desktop. */
enum ChatChannel: string
{
    /** WhatsApp, through the whatsapp-mcp bridge on the user's Mac. */
    case WhatsApp = 'whatsapp';
}
