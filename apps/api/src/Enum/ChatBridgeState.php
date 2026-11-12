<?php

declare(strict_types=1);

namespace App\Enum;

/** Whether the bridge on the relaying desktop runs, as that desktop last reported it. */
enum ChatBridgeState: string
{
    case Running = 'running';
    case Stopped = 'stopped';
}
