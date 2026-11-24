<?php

declare(strict_types=1);

namespace App\ApiResource\Input;

use App\Security\Scope;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * What a connected app may do from now on: the scopes it keeps, out of those the user granted it on the consent
 * screen. The others are switched off. A scope it was never granted needs the consent screen (422).
 */
final class UpdateConnectedApp
{
    /** @var list<string>|null */
    #[Assert\NotNull(message: 'Name the permissions the app keeps.')]
    #[Assert\Unique]
    #[Assert\All([new Assert\Choice(callback: [self::class, 'scopes'], message: 'An app that is not Tresso\'s own cannot have this permission.')])]
    public ?array $scopes = null;

    /** @return list<string> */
    public static function scopes(): array
    {
        return array_map(static fn (Scope $scope): string => $scope->value, Scope::thirdPartyAppScopes());
    }
}
