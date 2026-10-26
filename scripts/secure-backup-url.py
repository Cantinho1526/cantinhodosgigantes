"""Read the existing GitHub secret; force full TLS verification, without logging it."""
import os
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

def secure_url(raw):
    u = urlsplit(raw)
    if u.scheme not in ('postgres', 'postgresql') or not u.hostname:
        raise ValueError('Conexão PostgreSQL inválida')
    blocked = {'sslmode', 'sslrootcert', 'sslcert', 'sslkey'}
    params = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if k.lower() not in blocked]
    params += [('sslmode', 'verify-full'), ('sslrootcert', '/backup/ca.pem')]
    return urlunsplit((u.scheme, u.netloc, u.path, urlencode(params), ''))

if __name__ == '__main__':
    print(secure_url(os.environ['AIVEN_DATABASE_URL']))
