#!/bin/sh
set -e

# Nothing starts on a missing or development secret: the image's built-in .env values are public.
php bin/console app:settings:check --no-interaction

# The API container (RUN_MIGRATIONS=1) prepares what every container shares; workers start once it is healthy.
if [ "$1" = "frankenphp" ] && [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
    # OAuth2 signing keys, made once and kept in the config/jwt volume.
    if [ ! -f config/jwt/private.pem ]; then
        (
            umask 077
            openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
                -aes-256-cbc -pass env:OAUTH_PASSPHRASE -out config/jwt/private.pem
        )
        openssl pkey -in config/jwt/private.pem -passin env:OAUTH_PASSPHRASE -pubout -out config/jwt/public.pem
    fi
    php bin/console doctrine:migrations:migrate --no-interaction --allow-no-migration
    php bin/console app:oauth:bootstrap-clients --no-interaction
fi

exec docker-php-entrypoint "$@"
