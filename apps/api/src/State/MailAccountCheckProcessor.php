<?php

declare(strict_types=1);

namespace App\State;

use ApiPlatform\Metadata\Operation;
use ApiPlatform\State\ProcessorInterface;
use ApiPlatform\Validator\Exception\ValidationException;
use App\ApiResource\Input\CheckMailAccount;
use App\ApiResource\MailAccountCheck;
use App\Mail\Check\CheckLock;
use App\Mail\Check\ConnectionCheck;
use App\Mail\Check\MailConnectionChecker;
use App\Repository\MailAccountRepository;
use App\Security\CurrentUser;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;
use Symfony\Component\RateLimiter\RateLimiterFactoryInterface;
use Symfony\Component\Validator\ConstraintViolation;
use Symfony\Component\Validator\ConstraintViolationList;

/**
 * @implements ProcessorInterface<CheckMailAccount, MailAccountCheck>
 */
final readonly class MailAccountCheckProcessor implements ProcessorInterface
{
    public function __construct(
        private MailConnectionChecker $checker,
        private CheckLock $lock,
        private MailAccountRepository $accounts,
        private CurrentUser $currentUser,
        #[Autowire(service: 'limiter.mail_account_check')]
        private RateLimiterFactoryInterface $limiter,
    ) {
    }

    public function process(mixed $data, Operation $operation, array $uriVariables = [], array $context = []): MailAccountCheck
    {
        $owner = $this->currentUser->get();
        $emailAddress = mb_strtolower(trim($data->emailAddress));
        // Said before anything is tried, as creating the account would.
        if ($this->accounts->existsForOwner($owner, $emailAddress)) {
            throw new ValidationException(new ConstraintViolationList([
                new ConstraintViolation('You already connected this email address.', null, [], $data, 'emailAddress', $data->emailAddress),
            ]));
        }

        $imap = $data->imap ?? throw new \LogicException('Validation guarantees IMAP settings.');
        $smtp = $data->smtp ?? throw new \LogicException('Validation guarantees SMTP settings.');
        $userId = $owner->getId()->toRfc4122();
        // The lock comes first, so a request that waits for the user's previous check costs no token of the limit. A
        // check the client gave up on runs to its deadline: PHP only notices a client that left when it writes output,
        // and a check writes nothing until it is done. That answer is 409 (not 429): the client retries it quietly.
        $result = $this->lock->run($userId, function () use ($userId, $imap, $smtp, $data): ConnectionCheck {
            // Every check makes the API connect to a server the user named; a limit keeps that from becoming a port
            // scanner.
            $limit = $this->limiter->create($userId)->consume();
            if (!$limit->isAccepted()) {
                throw new TooManyRequestsHttpException($limit->getRetryAfter()->getTimestamp() - time(), 'Too many connection checks. Wait a few minutes, then try again.');
            }
            // Both servers within the checker's total budget, with room for the answer: more than PHP's default 30
            // seconds. Only a limit is raised; where there is none (the command line, the tests) none is set.
            if (0 !== (int) \ini_get('max_execution_time')) {
                set_time_limit(MailConnectionChecker::TOTAL + 15);
            }

            return $this->checker->check($imap, $smtp, $data->username, $data->password);
        }) ?? throw new ConflictHttpException('Your previous connection check is still running. It ends within 25 seconds.', headers: ['Retry-After' => '2']);

        return new MailAccountCheck($emailAddress, $result->imap->value, $result->smtp->value, $result->folders, $result->detail);
    }
}
