<?php

declare(strict_types=1);

namespace App\Classification;

/**
 * Puts an incoming message in a smart inbox and gives it a verdict.
 *
 * Tresso uses {@see RuleBasedClassifier}. Another classifier replaces or extends it by decorating this service
 * (`#[AsDecorator(Classifier::class)]`), for example to ask a model with each smart inbox's instructions and fall back
 * to the rules. Decorators should keep the user's sender rules and the include and exclude lists in charge: they are
 * what the user told Tresso explicitly.
 */
interface Classifier
{
    public function classify(MailToClassify $mail, ClassificationContext $context): Classification;
}
