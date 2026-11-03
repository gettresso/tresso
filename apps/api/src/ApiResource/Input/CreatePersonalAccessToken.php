<?php

declare(strict_types=1);

namespace App\ApiResource\Input;

use App\Security\PersonalAccessToken\PersonalAccessTokens;
use App\Security\Scope;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * A new personal access token: what it is called, what it may do and how many days it lasts.
 */
final class CreatePersonalAccessToken
{
    #[Assert\NotBlank(normalizer: 'trim')]
    #[Assert\Length(max: 80)]
    public string $name = '';

    /** @var list<string> */
    #[Assert\Count(min: 1, minMessage: 'Choose at least one permission.')]
    #[Assert\Unique]
    #[Assert\All([new Assert\Choice(callback: [self::class, 'allowedScopes'], message: 'A personal access token cannot have this permission.')])]
    public array $scopes = [];

    #[Assert\Choice(choices: PersonalAccessTokens::LIFETIMES_IN_DAYS, message: 'Choose 30, 90 or 365 days.')]
    public int $expiresInDays = PersonalAccessTokens::DEFAULT_LIFETIME_IN_DAYS;

    /** @return list<string> */
    public static function allowedScopes(): array
    {
        return array_map(static fn (Scope $scope): string => $scope->value, Scope::personalAccessTokenScopes());
    }
}
