<?php

declare(strict_types=1);

namespace App\Entity;

use App\Enum\ChatBridgeState;
use App\Enum\ChatChannel;
use App\Enum\ChatLinkState;
use App\Repository\ChatAccountRepository;
use App\Sync\Change\TracksChanges;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;
use Symfony\Bridge\Doctrine\Types\UuidType;
use Symfony\Component\Uid\Uuid;

/**
 * The user's account on a chat channel (WhatsApp), relayed to the server by one of the user's desktops: the relay.
 * Only "All my devices" makes one; "Only this Mac" keeps chats on the desktop and tells the server nothing.
 *
 * The own number and name are sealed with the owner's field key ({@see \App\Chat\ChatFields}): nothing that says who
 * the user is on the channel is stored readable. Removing the account removes its chats, messages and replies (the
 * database cascades; clients infer it from the account's tombstone).
 */
#[ORM\Entity(repositoryClass: ChatAccountRepository::class)]
#[ORM\Index(columns: ['owner_id', 'change_seq'])]
#[ORM\UniqueConstraint(columns: ['owner_id', 'channel'])]
class ChatAccount implements TracksChanges
{
    public const int MAX_DEVICE_NAME = 255;

    #[ORM\Id]
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $id;

    #[ORM\Column(type: Types::BIGINT, options: ['default' => 0])]
    private int $changeSeq = 0;

    #[ORM\ManyToOne]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private User $owner;

    #[ORM\Column(length: 16, enumType: ChatChannel::class)]
    private ChatChannel $channel;

    /** The own number, digits only, sealed; null when the desktop did not know it. */
    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $sealedAddress = null;

    /** The own name on the channel, sealed. */
    #[ORM\Column(type: Types::TEXT, nullable: true)]
    private ?string $sealedDisplayName = null;

    /** The desktop that relays: an id it made once for itself. */
    #[ORM\Column(type: UuidType::NAME)]
    private Uuid $relayDeviceId;

    #[ORM\Column(length: self::MAX_DEVICE_NAME)]
    private string $relayDeviceName;

    /** When the relay was last heard from. Not a change for clients: only {@see $relayOnline} flipping is. */
    #[ORM\Column]
    private \DateTimeImmutable $relaySeenAt;

    #[ORM\Column]
    private bool $relayOnline = true;

    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $relayOfflineSince = null;

    #[ORM\Column(length: 16, enumType: ChatBridgeState::class)]
    private ChatBridgeState $bridgeState = ChatBridgeState::Running;

    #[ORM\Column(length: 16, enumType: ChatLinkState::class)]
    private ChatLinkState $linkState = ChatLinkState::Unknown;

    /** When the relay saw the bridge get linked; null when it did not see it happen. */
    #[ORM\Column(nullable: true)]
    private ?\DateTimeImmutable $linkedAt = null;

    /** Whether the bridge listens on loopback only; null until the relay checked. */
    #[ORM\Column(nullable: true)]
    private ?bool $loopbackOnly = null;

    #[ORM\Column(options: ['default' => true])]
    private bool $includeGroups;

    #[ORM\Column(options: ['default' => false])]
    private bool $notify;

    #[ORM\Column]
    private \DateTimeImmutable $createdAt;

    public function __construct(
        User $owner,
        ChatChannel $channel,
        Uuid $relayDeviceId,
        string $relayDeviceName,
        bool $includeGroups,
        bool $notify,
        \DateTimeImmutable $now,
    ) {
        $this->id = Uuid::v7();
        $this->owner = $owner;
        $this->channel = $channel;
        $this->relayDeviceId = $relayDeviceId;
        $this->relayDeviceName = $relayDeviceName;
        $this->relaySeenAt = $now;
        $this->includeGroups = $includeGroups;
        $this->notify = $notify;
        $this->createdAt = $now;
    }

    public function getId(): Uuid
    {
        return $this->id;
    }

    public function getOwner(): User
    {
        return $this->owner;
    }

    public function getChannel(): ChatChannel
    {
        return $this->channel;
    }

    public function getSealedAddress(): ?string
    {
        return $this->sealedAddress;
    }

    public function getSealedDisplayName(): ?string
    {
        return $this->sealedDisplayName;
    }

    /** Through {@see \App\Chat\ChatFields} only, which seals for this row. */
    public function sealIdentity(?string $sealedAddress, ?string $sealedDisplayName): void
    {
        $this->sealedAddress = $sealedAddress;
        $this->sealedDisplayName = $sealedDisplayName;
    }

    public function getRelayDeviceId(): Uuid
    {
        return $this->relayDeviceId;
    }

    public function getRelayDeviceName(): string
    {
        return $this->relayDeviceName;
    }

    public function getRelaySeenAt(): \DateTimeImmutable
    {
        return $this->relaySeenAt;
    }

    public function isRelayOnline(): bool
    {
        return $this->relayOnline;
    }

    public function getRelayOfflineSince(): ?\DateTimeImmutable
    {
        return $this->relayOfflineSince;
    }

    /**
     * The calling desktop relays from now on (it may be the one that did already): another one sees the change in the
     * delta and stops. It was just heard from, so it is online.
     */
    public function relayFrom(Uuid $deviceId, string $deviceName, \DateTimeImmutable $now): void
    {
        if (!$this->relayDeviceId->equals($deviceId)) {
            $this->relayDeviceId = $deviceId;
        }
        $this->relayDeviceName = $deviceName;
        $this->relaySeenAt = $now;
        $this->relayOnline = true;
        $this->relayOfflineSince = null;
    }

    /**
     * The relay was just heard from. That alone is no change for clients; it is when the relay was offline, which it is
     * then no longer.
     */
    public function heardFromRelay(\DateTimeImmutable $now): void
    {
        $this->relaySeenAt = $now;
        if (!$this->relayOnline) {
            $this->relayOnline = true;
            $this->relayOfflineSince = null;
        }
    }

    /**
     * What the relay reports of the bridge. A value that is the same as before is not assigned, so a report that
     * changes nothing is no change for clients.
     */
    public function reportBridge(ChatBridgeState $bridge, ChatLinkState $link, ?\DateTimeImmutable $linkedAt, ?bool $loopbackOnly): void
    {
        if ($bridge !== $this->bridgeState) {
            $this->bridgeState = $bridge;
        }
        if ($link !== $this->linkState) {
            $this->linkState = $link;
        }
        if ($linkedAt?->getTimestamp() !== $this->linkedAt?->getTimestamp()) {
            $this->linkedAt = $linkedAt;
        }
        if ($loopbackOnly !== $this->loopbackOnly) {
            $this->loopbackOnly = $loopbackOnly;
        }
    }

    public function getBridgeState(): ChatBridgeState
    {
        return $this->bridgeState;
    }

    public function getLinkState(): ChatLinkState
    {
        return $this->linkState;
    }

    public function getLinkedAt(): ?\DateTimeImmutable
    {
        return $this->linkedAt;
    }

    public function isLoopbackOnly(): ?bool
    {
        return $this->loopbackOnly;
    }

    public function includesGroups(): bool
    {
        return $this->includeGroups;
    }

    public function setIncludeGroups(bool $includeGroups): void
    {
        $this->includeGroups = $includeGroups;
    }

    public function notifies(): bool
    {
        return $this->notify;
    }

    public function setNotify(bool $notify): void
    {
        $this->notify = $notify;
    }

    public function getCreatedAt(): \DateTimeImmutable
    {
        return $this->createdAt;
    }

    public function getChangeOwner(): User
    {
        return $this->owner;
    }

    public static function clientFields(): ?array
    {
        return ['channel', 'sealedAddress', 'sealedDisplayName', 'relayDeviceId', 'relayDeviceName', 'relayOnline', 'relayOfflineSince', 'bridgeState', 'linkState', 'linkedAt', 'loopbackOnly', 'includeGroups', 'notify'];
    }

    public static function changeType(): string
    {
        return 'chatAccount';
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
