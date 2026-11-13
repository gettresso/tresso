<?php

namespace App;

use App\Chat\ChatMediaLimits;
use App\Security\PersonalAccessToken\OAuth2SkipsPersonalAccessTokensPass;
use Symfony\Bundle\FrameworkBundle\Kernel\MicroKernelTrait;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\HttpKernel\Kernel as BaseKernel;

class Kernel extends BaseKernel
{
    use MicroKernelTrait;

    /**
     * Settings that would break the app wherever they are first used are checked as it starts, so a wrong value stops
     * every request and command with what is wrong instead of failing one route at a time.
     */
    public function boot(): void
    {
        ChatMediaLimits::check($_SERVER['CHAT_MAX_FILE_BYTES'] ?? $_ENV['CHAT_MAX_FILE_BYTES'] ?? null);
        parent::boot();
    }

    protected function build(ContainerBuilder $container): void
    {
        $container->addCompilerPass(new OAuth2SkipsPersonalAccessTokensPass());
    }

    /**
     * @return list<string> An array of allowed values for APP_ENV
     */
    private function getAllowedEnvs(): array
    {
        return ['prod', 'dev', 'test'];
    }
}
