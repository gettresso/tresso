<?php

declare(strict_types=1);

namespace App\Entity;

use App\Repository\MeetingPreferencesRepository;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/**
 * Which app makes the meeting link of a new event: a default per mail account and one for every other calendar, the
 * user's own room link, whether a link is switched on when the first guest is added, and the apps the user switched
 * off in Tresso for an account. A user without a row has no own link, no defaults and the switch on.
 *
 * The own link is a capability (anyone who has it may enter the room): it is kept as plaintext like all calendar data,
 * and never goes into a log line or an error message.
 */
#[ORM\Entity(repositoryClass: MeetingPreferencesRepository::class)]
class MeetingPreferences
{
    /** The apps a default can name. */
    public const array APPS = ['meet', 'teams', 'zoom', 'own'];

    /** What a default can be: an app, or no meeting link. */
    public const array DEFAULTS = [...self::APPS, 'none'];

    /** The apps the user can switch off for a mail account: those the account's calendar provider makes. */
    public const array SWITCHABLE = ['meet', 'teams'];

    #[ORM\Id]
    #[ORM\OneToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $user;

    #[ORM\Column(length: 2048, nullable: true)]
    private ?string $ownLink = null;

    #[ORM\Column(options: ['default' => true])]
    private bool $addWithGuests = true;

    /**
     * Mail account id to one of {@see self::DEFAULTS}.
     *
     * @var array<string, string>
     */
    #[ORM\Column(type: Types::JSON, options: ['default' => '{}'])]
    private array $defaults = [];

    /** The default for calendars without an entry in $defaults (Tresso calendars, new accounts); null: none chosen. */
    #[ORM\Column(length: 8, nullable: true)]
    private ?string $defaultOther = null;

    /**
     * Apps the user switched off in Tresso for one mail account.
     *
     * @var list<array{app: string, mailAccountId: string}>
     */
    #[ORM\Column(type: Types::JSON, options: ['default' => '[]'])]
    private array $disabled = [];

    #[ORM\Column]
    private \DateTimeImmutable $updatedAt;

    public function __construct(User $user)
    {
        $this->user = $user;
        $this->updatedAt = new \DateTimeImmutable();
    }

    public function getUser(): User
    {
        return $this->user;
    }

    public function getOwnLink(): ?string
    {
        return $this->ownLink;
    }

    /**
     * @param string|null $ownLink a link that passed {@see \App\Calendar\MeetingLinkAddress::violation()}, or null
     */
    public function setOwnLink(#[\SensitiveParameter] ?string $ownLink): void
    {
        $this->ownLink = $ownLink;
        $this->touch();
    }

    public function addsWithGuests(): bool
    {
        return $this->addWithGuests;
    }

    public function setAddWithGuests(bool $addWithGuests): void
    {
        $this->addWithGuests = $addWithGuests;
        $this->touch();
    }

    /**
     * @return array<string, string>
     */
    public function getDefaults(): array
    {
        return $this->defaults;
    }

    /**
     * @param array<string, string> $defaults
     */
    public function setDefaults(array $defaults): void
    {
        $this->defaults = $defaults;
        $this->touch();
    }

    public function getDefaultOther(): ?string
    {
        return $this->defaultOther;
    }

    public function setDefaultOther(?string $defaultOther): void
    {
        $this->defaultOther = $defaultOther;
        $this->touch();
    }

    /**
     * @return list<array{app: string, mailAccountId: string}>
     */
    public function getDisabled(): array
    {
        return $this->disabled;
    }

    /**
     * @param list<array{app: string, mailAccountId: string}> $disabled
     */
    public function setDisabled(array $disabled): void
    {
        $this->disabled = $disabled;
        $this->touch();
    }

    public function getUpdatedAt(): \DateTimeImmutable
    {
        return $this->updatedAt;
    }

    private function touch(): void
    {
        $this->updatedAt = new \DateTimeImmutable();
    }
}
