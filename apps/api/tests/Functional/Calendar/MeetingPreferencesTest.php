<?php

declare(strict_types=1);

namespace App\Tests\Functional\Calendar;

use App\Entity\MailAccount;
use App\Entity\User;
use App\Enum\MailProvider;
use App\Repository\UserRepository;
use App\Tests\Functional\AuthenticatesUsers;
use App\Tests\Functional\DatabaseTestCase;
use App\Tests\Support\QueryLog;
use Doctrine\ORM\EntityManagerInterface;

/**
 * GET and PATCH /api/v1/calendar/meeting-preferences: which app makes the meeting link of a new event, the user's own
 * room link and the guests switch. The own link is a capability, so no answer ever repeats a refused one.
 */
final class MeetingPreferencesTest extends DatabaseTestCase
{
    use AuthenticatesUsers;

    private const string URI = '/api/v1/calendar/meeting-preferences';
    private const string ROOM = 'https://meet.company.example/kim';
    /** A mail account id nobody has. */
    private const string UNKNOWN_ACCOUNT = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

    /** @var array<string, string> */
    private array $kim;

    private string $gmail;

    private string $microsoft;

    private string $imap;

    protected function setUp(): void
    {
        parent::setUp();
        $this->bootstrapOAuthClients();
        $this->createUser('kim@example.test', 'Kim');
        $this->createUser('lisa@example.test', 'Lisa');
        $this->kim = $this->userHeaders('kim@example.test', ['settings:read', 'settings:write']);
        $this->gmail = $this->createAccount('kim@example.test', 'kim@gmail.example', MailProvider::Gmail);
        $this->microsoft = $this->createAccount('kim@example.test', 'kim@company.example', MailProvider::Microsoft);
        $this->imap = $this->createAccount('kim@example.test', 'kim@fastmail.example', MailProvider::Imap);
    }

    public function testAUserWithoutPreferencesGetsTheDefaults(): void
    {
        $this->client->request('GET', self::URI, server: $this->kim);
        self::assertResponseIsSuccessful();

        self::assertSame([
            'ownLink' => null,
            'addWithGuests' => true,
            'defaults' => [],
            'defaultOther' => null,
            'disabled' => [],
            'apps' => ['meet', 'teams', 'own'],
        ], $this->decodedResponse());
        $content = (string) $this->client->getResponse()->getContent();
        self::assertStringContainsString('"defaults":{}', $content, 'An empty map is a JSON object.');
        self::assertStringContainsString('"disabled":[]', $content);
        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM meeting_preferences'), 'Reading creates nothing.');
    }

    public function testEveryFieldChangesAndWhatIsLeftOutStays(): void
    {
        $this->patch(['ownLink' => self::ROOM]);
        $this->patch(['addWithGuests' => false]);
        $this->patch(['defaults' => [$this->gmail => 'meet', $this->microsoft => 'teams', $this->imap => 'own']]);
        $this->patch(['defaultOther' => 'none']);
        $this->patch(['disabled' => [['app' => 'meet', 'mailAccountId' => $this->gmail], ['app' => 'teams', 'mailAccountId' => $this->microsoft]]]);
        $answer = $this->patch(['ownLink' => null, 'defaultOther' => null]);

        $expected = [
            'ownLink' => self::ROOM,
            'addWithGuests' => false,
            'defaults' => [$this->gmail => 'meet', $this->microsoft => 'teams', $this->imap => 'own'],
            'defaultOther' => 'none',
            'disabled' => [['app' => 'meet', 'mailAccountId' => $this->gmail], ['app' => 'teams', 'mailAccountId' => $this->microsoft]],
            'apps' => ['meet', 'teams', 'own'],
        ];
        self::assertSame($expected, $answer, 'null leaves a field as it is.');
        self::assertSame($expected, $this->get());
        $row = $this->connection()->fetchAssociative('SELECT own_link, add_with_guests, default_other FROM meeting_preferences WHERE user_id = ?', [$this->userId('kim@example.test')]);
        self::assertSame(['own_link' => self::ROOM, 'add_with_guests' => false, 'default_other' => 'none'], $row);
    }

    public function testDefaultsAndDisabledAreReplacedWhole(): void
    {
        $this->patch(['defaults' => [$this->gmail => 'meet', $this->microsoft => 'teams'], 'disabled' => [['app' => 'meet', 'mailAccountId' => $this->gmail]]]);

        $answer = $this->patch(['defaults' => [$this->microsoft => 'own'], 'disabled' => []]);

        self::assertSame([$this->microsoft => 'own'], $answer['defaults']);
        self::assertSame([], $answer['disabled']);
        $this->patch(['defaults' => []]);
        self::assertStringContainsString('"defaults":{}', (string) $this->client->getResponse()->getContent());
    }

    public function testTheSameEntryTwiceIsKeptOnce(): void
    {
        $entry = ['app' => 'teams', 'mailAccountId' => $this->microsoft];

        self::assertSame([$entry], $this->patch(['disabled' => [$entry, $entry]])['disabled']);
    }

    public function testAnEmptyLinkClearsIt(): void
    {
        $this->patch(['ownLink' => self::ROOM]);

        self::assertNull($this->patch(['ownLink' => ''])['ownLink']);
        self::assertNull($this->connection()->fetchOne('SELECT own_link FROM meeting_preferences WHERE user_id = ?', [$this->userId('kim@example.test')]));
    }

    public function testALinkOfTheWrongFormIsRefusedWithoutRepeatingIt(): void
    {
        $this->patch(['ownLink' => self::ROOM]);

        foreach ([
            'http://secret-room.example/kim' => 'Use a link that starts with https://.',
            'https://kim:hunter2@secret-room.example/kim' => 'Use a link without a name or password in it.',
            'https://secret-room.example/kim room' => 'Use a link that starts with https://.',
            'https://secret-room.example/'.str_repeat('k', 2049 - 28) => 'Use a link of at most 2048 characters.',
        ] as $link => $message) {
            $this->patch(['ownLink' => $link, 'addWithGuests' => false], 422);

            $content = (string) $this->client->getResponse()->getContent();
            self::assertSame([['ownLink', $message]], $this->violations(), $message);
            self::assertStringNotContainsString('secret-room', $content, 'The answer never repeats the link.');
            self::assertStringNotContainsString('hunter2', $content);
        }
        self::assertSame(2049, \strlen('https://secret-room.example/'.str_repeat('k', 2049 - 28)));
        self::assertSame(self::ROOM, $this->get()['ownLink'], 'Nothing of a refused change is kept.');
        self::assertTrue($this->get()['addWithGuests']);
    }

    public function testDefaultsNameOnlyTheUsersOwnAccountsAndKnownApps(): void
    {
        $lisas = $this->createAccount('lisa@example.test', 'lisa@gmail.example', MailProvider::Gmail);

        foreach ([[$lisas => 'meet'], [self::UNKNOWN_ACCOUNT => 'meet'], ['not-an-id' => 'meet'], [$this->gmail => 'skype'], [$this->gmail => null]] as $defaults) {
            $this->patch(['defaults' => $defaults], 422);
            self::assertSame('defaults', $this->violations()[0][0]);
        }
        $this->patch(['defaultOther' => 'skype'], 422);
        self::assertSame([['defaultOther', 'Use meet, teams, zoom, own or none.']], $this->violations());

        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM meeting_preferences'));
    }

    public function testOnlyTheAppOfTheAccountsProviderCanBeSwitchedOff(): void
    {
        foreach ([
            [['app' => 'teams', 'mailAccountId' => $this->gmail], 'Microsoft Teams can only be switched off for a Microsoft account.'],
            [['app' => 'meet', 'mailAccountId' => $this->microsoft], 'Google Meet can only be switched off for a Google account.'],
            [['app' => 'meet', 'mailAccountId' => $this->imap], 'Google Meet can only be switched off for a Google account.'],
            [['app' => 'zoom', 'mailAccountId' => $this->gmail], 'Each entry has an app (meet or teams) and a mailAccountId.'],
            [['app' => 'meet'], 'Each entry has an app (meet or teams) and a mailAccountId.'],
            [['app' => 'meet', 'mailAccountId' => self::UNKNOWN_ACCOUNT], 'Use the id of one of your mail accounts.'],
        ] as [$entry, $message]) {
            $this->patch(['disabled' => [$entry]], 422);
            self::assertSame([['disabled', $message]], $this->violations(), $message);
        }
    }

    public function testEntriesOfAccountsThatAreGoneAreDroppedOnTheNextSave(): void
    {
        $this->patch(['defaults' => [$this->gmail => 'meet'], 'disabled' => [['app' => 'meet', 'mailAccountId' => $this->gmail]]]);
        // An account deleted since: its entries stay in the row until the next save.
        $this->connection()->executeStatement(
            'UPDATE meeting_preferences SET defaults = :defaults, disabled = :disabled WHERE user_id = :user',
            [
                'defaults' => json_encode([$this->gmail => 'meet', self::UNKNOWN_ACCOUNT => 'teams'], \JSON_THROW_ON_ERROR),
                'disabled' => json_encode([['app' => 'meet', 'mailAccountId' => $this->gmail], ['app' => 'teams', 'mailAccountId' => self::UNKNOWN_ACCOUNT]], \JSON_THROW_ON_ERROR),
                'user' => $this->userId('kim@example.test'),
            ],
        );

        $answer = $this->patch(['addWithGuests' => false]);

        self::assertSame([$this->gmail => 'meet'], $answer['defaults']);
        self::assertSame([['app' => 'meet', 'mailAccountId' => $this->gmail]], $answer['disabled']);
        $stored = $this->connection()->fetchOne('SELECT defaults FROM meeting_preferences WHERE user_id = ?', [$this->userId('kim@example.test')]);
        self::assertIsString($stored);
        self::assertStringNotContainsString(self::UNKNOWN_ACCOUNT, $stored);
    }

    public function testAnotherUserNeverSeesOrChangesThePreferences(): void
    {
        $this->patch(['ownLink' => self::ROOM, 'defaults' => [$this->gmail => 'meet']]);
        $lisa = $this->userHeaders('lisa@example.test', ['settings:read', 'settings:write']);

        $this->client->request('GET', self::URI, server: $lisa);
        self::assertResponseIsSuccessful();
        self::assertNull($this->decodedResponse()['ownLink']);
        self::assertSame([], $this->decodedResponse()['defaults']);

        $this->client->request('PATCH', self::URI, server: [...$lisa, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['defaults' => [$this->gmail => 'none']], \JSON_THROW_ON_ERROR));
        self::assertResponseStatusCodeSame(422, 'Kim\'s account is not one of Lisa\'s.');
        $this->client->request('PATCH', self::URI, server: [...$lisa, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['ownLink' => ''], \JSON_THROW_ON_ERROR));
        self::assertResponseIsSuccessful();

        $kims = $this->get();
        self::assertSame(self::ROOM, $kims['ownLink']);
        self::assertSame([$this->gmail => 'meet'], $kims['defaults']);
    }

    public function testReadingAndChangingNeedTheSettingsScopes(): void
    {
        $readOnly = $this->userHeaders('kim@example.test', ['settings:read']);
        $this->client->request('GET', self::URI, server: $readOnly);
        self::assertResponseIsSuccessful();
        $this->client->request('PATCH', self::URI, server: [...$readOnly, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode(['ownLink' => self::ROOM], \JSON_THROW_ON_ERROR));
        self::assertResponseStatusCodeSame(403);

        $calendarOnly = $this->userHeaders('kim@example.test', ['calendar:read', 'calendar:write']);
        $this->client->request('GET', self::URI, server: $calendarOnly);
        self::assertResponseStatusCodeSame(403);

        self::assertSame(0, $this->countRows('SELECT COUNT(*) FROM meeting_preferences'));
    }

    public function testTheFirstChangeCreatesThePreferencesOnceAndLocksThem(): void
    {
        $log = static::getContainer()->get(QueryLog::class);
        $log->clear();

        $this->patch(['addWithGuests' => false]);

        $sql = implode("\n", $log->queries());
        self::assertStringContainsString('ON CONFLICT (user_id) DO NOTHING', $sql, 'Two first changes at once find one row.');
        self::assertStringContainsString('FOR UPDATE', $sql);
        $this->patch(['defaultOther' => 'own']);
        self::assertSame(1, $this->countRows('SELECT COUNT(*) FROM meeting_preferences'));
        self::assertSame([false, 'own'], [$this->get()['addWithGuests'], $this->get()['defaultOther']]);
    }

    /**
     * @param array<string, mixed> $changes
     *
     * @return array<string, mixed>
     */
    private function patch(array $changes, int $status = 200): array
    {
        $this->client->request('PATCH', self::URI, server: [...$this->kim, 'CONTENT_TYPE' => 'application/merge-patch+json'], content: json_encode($changes, \JSON_THROW_ON_ERROR));
        self::assertResponseStatusCodeSame($status);

        /** @var array<string, mixed> */
        return $this->decodedResponse();
    }

    /**
     * @return array<string, mixed>
     */
    private function get(): array
    {
        $this->client->request('GET', self::URI, server: $this->kim);
        self::assertResponseIsSuccessful();

        /** @var array<string, mixed> */
        return $this->decodedResponse();
    }

    /**
     * @return list<array{mixed, mixed}> [propertyPath, message] per violation
     */
    private function violations(): array
    {
        $violations = $this->decodedResponse()['violations'] ?? null;
        self::assertIsArray($violations);

        return array_values(array_map(static fn (mixed $violation): array => \is_array($violation) ? [$violation['propertyPath'] ?? null, $violation['message'] ?? null] : [null, null], $violations));
    }

    private function createAccount(string $owner, string $emailAddress, MailProvider $provider): string
    {
        $entityManager = static::getContainer()->get(EntityManagerInterface::class);
        $user = static::getContainer()->get(UserRepository::class)->findOneBy(['email' => $owner]);
        self::assertInstanceOf(User::class, $user);
        $account = new MailAccount($user, $emailAddress, $emailAddress, $provider);
        $entityManager->persist($account);
        $entityManager->flush();

        return $account->getId()->toRfc4122();
    }

    private function userId(string $email): string
    {
        $user = static::getContainer()->get(UserRepository::class)->findOneBy(['email' => $email]);
        self::assertInstanceOf(User::class, $user);

        return $user->getId()->toRfc4122();
    }
}
