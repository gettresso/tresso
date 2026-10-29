#!/bin/sh
set -e

# Nothing starts on a missing or development secret: the image's built-in .env values are public.
php bin/console app:settings:check --no-interaction

# The API container (RUN_MIGRATIONS=1) prepares what every container shares; workers start once it is healthy.
if [ "$1" = "frankenphp" ] && [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
    # OAuth2 signing keys, made once and kept in the config/jwt volume. Each file is written next to its place and moved
    # there whole, so a stop halfway never leaves a partial key behind. The private key is encrypted with
    # OAUTH_PASSPHRASE: changing the passphrase later needs a new key (remove both files), which signs everyone out.
    if [ ! -f config/jwt/private.pem ]; then
        (
            umask 077
            openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
                -aes-256-cbc -pass env:OAUTH_PASSPHRASE -out config/jwt/private.pem.new
        )
        mv config/jwt/private.pem.new config/jwt/private.pem
        rm -f config/jwt/public.pem
    fi
    if [ ! -f config/jwt/public.pem ]; then
        openssl pkey -in config/jwt/private.pem -passin env:OAUTH_PASSPHRASE -pubout -out config/jwt/public.pem.new
        mv config/jwt/public.pem.new config/jwt/public.pem
    fi
    php bin/console doctrine:migrations:migrate --no-interaction --allow-no-migration
    php bin/console app:oauth:bootstrap-clients --no-interaction
fi

exec docker-php-entrypoint "$@"
