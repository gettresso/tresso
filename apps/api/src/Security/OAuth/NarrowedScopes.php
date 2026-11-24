<?php

declare(strict_types=1);

namespace App\Security\OAuth;

use App\Activity\ActivityApp;
use App\Entity\User;
use App\Repository\OAuthConsentRepository;
use App\Security\PersonalAccessToken\PersonalAccessTokenAuthentication;
use App\Security\Scope;
use League\Bundle\OAuth2ServerBundle\Security\Authentication\Token\OAuth2Token;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\Security\Core\Authentication\Token\TokenInterface;
use Symfony\Component\Security\Http\Event\AuthenticationTokenCreatedEvent;

/**
 * Narrows every request of an app that is not ours to what the user allows it now: the scopes of its access token
 * without those the user switched off in Tresso ({@see \App\Entity\OAuthConsent::getDisabledScopes()}). The security
 * token of the request is replaced by one without them, before anything checks a role, so the API, the voters and the
 * MCP tools (`tools/list` included) see only what is still allowed.
 *
 * Checked on every request, against the consent as it is at that moment, rather than by revoking tokens: a switch
 * takes effect on the next request with tokens already issued, and switching a scope back on works as soon, without
 * the app having to sign in again (its token still carries every scope the user granted). One indexed lookup per
 * request of such an app. Personal access tokens hold fixed scopes and are not narrowed; our own apps and the sync
 * worker have no consent.
 */
#[AsEventListener(event: AuthenticationTokenCreatedEvent::class)]
final readonly class NarrowedScopes
{
    /** Token attribute: the scopes of the access token the user switched off for the app. */
    public const string SWITCHED_OFF = 'tresso_switched_off_scopes';

    public function __construct(private OAuthConsentRepository $consents)
    {
    }

    public function __invoke(AuthenticationTokenCreatedEvent $event): void
    {
        $token = $event->getAuthenticatedToken();
        if (!$token instanceof OAuth2Token || $token instanceof PersonalAccessTokenAuthentication || !ActivityApp::isLogged($token->getOAuthClientId())) {
            return;
        }
        $user = $token->getUser();
        if (!$user instanceof User) {
            return;
        }

        // No consent: the app was disconnected, and its tokens were revoked with it.
        $consent = $this->consents->findOneFor($user, $token->getOAuthClientId());
        $switchedOff = null === $consent ? [] : array_values(array_intersect($token->getScopes(), $consent->getDisabledScopes()));
        if ([] === $switchedOff) {
            return;
        }

        $narrowed = new OAuth2Token(
            $user,
            $token->getCredentials(),
            $token->getOAuthClientId(),
            array_values(array_diff($token->getScopes(), $switchedOff)),
            Scope::ROLE_PREFIX,
        );
        $narrowed->setAttribute(self::SWITCHED_OFF, $switchedOff);
        $event->setAuthenticatedToken($narrowed);
    }

    /**
     * The scopes switched off for the app of this security token, if any.
     *
     * @return list<string>
     */
    public static function switchedOff(?TokenInterface $token): array
    {
        if (null === $token || !$token->hasAttribute(self::SWITCHED_OFF)) {
            return [];
        }
        $scopes = $token->getAttribute(self::SWITCHED_OFF);

        return \is_array($scopes) ? array_values(array_filter($scopes, \is_string(...))) : [];
    }
}
