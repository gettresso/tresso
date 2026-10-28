<?php

declare(strict_types=1);

namespace App\ApiResource\Input\SmartInbox;

use App\Classification\SenderPattern;
use App\Entity\Category;
use App\Enum\Verdict;
use Symfony\Component\Validator\Constraints as Assert;

/**
 * A new custom smart inbox.
 */
final class CreateSmartInbox
{
    #[Assert\NotBlank(normalizer: 'trim')]
    #[Assert\Length(max: Category::NAME_MAX_LENGTH)]
    public string $name = '';

    /** What belongs here, in plain words. AI classifiers read it; the rules do not. */
    #[Assert\Length(max: Category::INSTRUCTIONS_MAX_LENGTH)]
    public string $instructions = '';

    /**
     * Addresses or `@domain`s whose mail always lands here.
     *
     * @var list<string>
     */
    #[Assert\Count(max: Category::SENDERS_MAX_COUNT)]
    #[Assert\All([new Assert\Type('string'), new Assert\Regex(SenderPattern::REGEX, message: 'Use an address or @domain.', normalizer: 'trim')])]
    public array $includeSenders = [];

    /**
     * Addresses or `@domain`s whose mail never lands here; wins over everything else.
     *
     * @var list<string>
     */
    #[Assert\Count(max: Category::SENDERS_MAX_COUNT)]
    #[Assert\All([new Assert\Type('string'), new Assert\Regex(SenderPattern::REGEX, message: 'Use an address or @domain.', normalizer: 'trim')])]
    public array $excludeSenders = [];

    #[Assert\NotBlank]
    #[Assert\Choice(callback: [Verdict::class, 'values'])]
    public string $verdict = '';

    /** New mail judged `do` here becomes a todo; only with the `do` verdict. */
    public bool $autoCreateTodo = false;

    /** Hold new mail until the user's next batch time instead of delivering it as it comes. */
    public bool $batchDelivery = false;
}
