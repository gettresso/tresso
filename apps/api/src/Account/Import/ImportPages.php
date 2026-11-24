<?php

declare(strict_types=1);

namespace App\Account\Import;

use App\Deployment\PublicAddresses;
use Symfony\Component\Uid\Uuid;

/**
 * The web app's pages where the user connects mail accounts, as links an assistant can hand to the user: the page of
 * an import list, and Settings, Accounts, where an account whose sign-in failed is signed in again.
 */
final readonly class ImportPages
{
    public const string IMPORT_PATH = '/settings/accounts/import/';
    public const string ACCOUNTS_PATH = '/settings/accounts';

    public function __construct(private PublicAddresses $addresses)
    {
    }

    public function importPage(Uuid $id): string
    {
        return $this->web().self::IMPORT_PATH.$id->toRfc4122();
    }

    /** Settings, Accounts, scrolled to the account. */
    public function accountPage(Uuid $mailAccountId): string
    {
        return $this->web().self::ACCOUNTS_PATH.'#account-'.$mailAccountId->toRfc4122();
    }

    private function web(): string
    {
        $web = $this->addresses->web();
        if ('' === $web) {
            throw new \LogicException('WEB_APP_URL is empty, so there is no page to send the user to.');
        }

        return $web;
    }
}
