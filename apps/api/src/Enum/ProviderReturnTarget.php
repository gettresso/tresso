<?php

declare(strict_types=1);

namespace App\Enum;

/**
 * Where the browser goes back to after a provider sign-in. The client picks one of these when it starts; the URL
 * behind each comes from the server's own settings, so a sign-in can never send its answer anywhere else.
 */
enum ProviderReturnTarget: string
{
    /** The web app (WEB_APP_URL), in the browser tab the sign-in started from. */
    case Web = 'web';
    /**
     * The desktop app, through its own link (NATIVE_REDIRECT_URI): it opens the provider in the system browser, and
     * the link brings the answer back to the app, where the user's tokens are.
     */
    case Native = 'native';
}
