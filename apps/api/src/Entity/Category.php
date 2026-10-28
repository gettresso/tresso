<?php

declare(strict_types=1);

namespace App\Entity;

use App\Classification\SenderPattern;
use App\Enum\BuiltinCategory;
use App\Enum\Verdict;
use App\Repository\CategoryRepository;
use App\Sync\Change\TracksChanges;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * A smart inbox (called a category in the schema). Built-in ones are created per user so their instructions and
 * lists stay editable; custom ones are the user's own. Mail lands in exactly one smart inbox, whose verdict it gets
 * unless a sender rule says otherwise.
 */
#[ORM\Entity(repositoryClass: CategoryRepository::class)]
#[ORM\UniqueConstraint(columns: ['owner_id', 'builtin'])]
#[ORM\Index(columns: ['owner_id', 'change_seq'])]
class Category implements TracksChanges
{
    public const int NAME_MAX_LENGTH = 80;
    public const int INSTRUCTIONS_MAX_LENGTH = 2000;
    public const int SENDERS_MAX_COUNT = 500;

    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\Column(type: Types::BIGINT, options: ['default' => 0])]
    private int $changeSeq = 0;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $owner;

    #[ORM\Column(length: 16, nullable: true, enumType: BuiltinCategory::class)]
    private ?BuiltinCategory $builtin;

    #[ORM\Column(length: self::NAME_MAX_LENGTH)]
    private string $name;

    /**
     * Natural-language description for the planned AI classification to recognise this category; the rules do not
     * read it.
     */
    #[ORM\Column(type: Types::TEXT)]
    private string $instructions;

    /**
     * Addresses or domains (`@example.com`) that always land in this category.
     *
     * @var list<string>
     */
    #[ORM\Column(type: Types::JSON)]
    private array $includeSenders = [];

    /**
     * Addresses or domains that never land in this category.
     *
     * @var list<string>
     */
    #[ORM\Column(type: Types::JSON)]
    private array $excludeSenders = [];

    #[ORM\Column(length: 16, enumType: Verdict::class)]
    private Verdict $verdict;

    #[ORM\Column]
    private bool $autoCreateTodo = false;

    /** Deliver in batches a few times a day instead of immediately. */
    #[ORM\Column]
    private bool $batchDelivery = false;

    #[ORM\Column]
    private bool $notify = true;

    #[ORM\Column]
    private int $position = 0;

    public function __construct(User $owner, string $name, string $instructions, Verdict $verdict, ?BuiltinCategory $builtin = null)
    {
        $this->id = Uuid::v7();
        $this->owner = $owner;
        $this->name = $name;
        $this->instructions = $instructions;
        $this->verdict = $verdict;
        $this->builtin = $builtin;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getOwner(): User
    {
        return $this->owner;
    }

    public function getBuiltin(): ?BuiltinCategory
    {
        return $this->builtin;
    }

    public function isBuiltin(): bool
    {
        return null !== $this->builtin;
    }

    /** Whether an entry of the include list covers this sender. */
    public function includes(string $address): bool
    {
        return self::listMatches($this->includeSenders, $address);
    }

    /** Whether an entry of the exclude list covers this sender. The exclude list wins over everything else. */
    public function excludes(string $address): bool
    {
        return self::listMatches($this->excludeSenders, $address);
    }

    /**
     * The exclude list entry that covers this sender other than the address itself (a domain), or null. Such an entry
     * outlives {@see stopExcluding()} of the address.
     */
    public function exclusionOtherThan(string $address): ?string
    {
        $address = SenderPattern::normalize($address);
        foreach ($this->excludeSenders as $entry) {
            if ($entry !== $address && SenderPattern::matches($entry, $address)) {
                return $entry;
            }
        }

        return null;
    }

    /** Takes an exact entry off the exclude list, e.g. when the user moves mail from that sender here. */
    public function stopExcluding(string $pattern): void
    {
        $pattern = SenderPattern::normalize($pattern);
        if (\in_array($pattern, $this->excludeSenders, true)) {
            $this->excludeSenders = array_values(array_filter($this->excludeSenders, static fn (string $entry): bool => $entry !== $pattern));
        }
    }

    /**
     * @param list<string> $patterns
     *
     * @return list<string>
     */
    private static function normalized(array $patterns): array
    {
        return array_values(array_unique(array_filter(array_map(SenderPattern::normalize(...), $patterns), static fn (string $p): bool => '' !== $p)));
    }

    /** @param list<string> $patterns */
    private static function listMatches(array $patterns, string $address): bool
    {
        foreach ($patterns as $pattern) {
            if (SenderPattern::matches($pattern, $address)) {
                return true;
            }
        }

        return false;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function setName(string $name): void
    {
        $this->name = $name;
    }

    public function getInstructions(): string
    {
        return $this->instructions;
    }

    public function setInstructions(string $instructions): void
    {
        $this->instructions = $instructions;
    }

    /** @return list<string> */
    public function getIncludeSenders(): array
    {
        return $this->includeSenders;
    }

    /** @param list<string> $includeSenders */
    public function setIncludeSenders(array $includeSenders): void
    {
        $this->includeSenders = self::normalized($includeSenders);
    }

    /** @return list<string> */
    public function getExcludeSenders(): array
    {
        return $this->excludeSenders;
    }

    /** @param list<string> $excludeSenders */
    public function setExcludeSenders(array $excludeSenders): void
    {
        $this->excludeSenders = self::normalized($excludeSenders);
    }

    public function getVerdict(): Verdict
    {
        return $this->verdict;
    }

    public function setVerdict(Verdict $verdict): void
    {
        $this->verdict = $verdict;
    }

    public function isAutoCreateTodo(): bool
    {
        return $this->autoCreateTodo;
    }

    public function setAutoCreateTodo(bool $autoCreateTodo): void
    {
        $this->autoCreateTodo = $autoCreateTodo;
    }

    public function isBatchDelivery(): bool
    {
        return $this->batchDelivery;
    }

    public function setBatchDelivery(bool $batchDelivery): void
    {
        $this->batchDelivery = $batchDelivery;
    }

    public function isNotify(): bool
    {
        return $this->notify;
    }

    public function setNotify(bool $notify): void
    {
        $this->notify = $notify;
    }

    public function getPosition(): int
    {
        return $this->position;
    }

    public function setPosition(int $position): void
    {
        $this->position = $position;
    }

    public function getChangeOwner(): User
    {
        return $this->owner;
    }

    public static function clientFields(): ?array
    {
        return ['builtin', 'name', 'instructions', 'includeSenders', 'excludeSenders', 'verdict', 'autoCreateTodo', 'batchDelivery', 'position'];
    }

    public static function changeType(): string
    {
        return 'smartInbox';
    }

    public function getChangeSeq(): int
    {
        return $this->changeSeq;
    }

    public function setChangeSeq(int $changeSeq): void
    {
        $this->changeSeq = $changeSeq;
    }
}
