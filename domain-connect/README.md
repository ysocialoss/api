# Domain Connect template

`ysocial.cc.verify-domain.json` lets DNS providers add the ownership TXT record for a user in one click
(https://www.domainconnect.org). It is linted with `dc-template-linter` (`-merge-or-fail` and `-tolerate warn` both pass).

## One-time setup

1. **Public key in DNS.** The template sets `syncPubKeyDomain: ysocial.cc`, so requests are signed.
   Add these TXT records on `_dck1.ysocial.cc` (all three, same name):

```
p=1,a=RS256,d=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAouQWMWohZuV1CRUo7j9oHKBqIpp6wkdU1I/ZMm7E9eXZNceeQlY/gsZAFQXoH+HleAycFOgsdmv92KijHHYA6z+bxX92TbSMs/amrHrlHm55+X4Up17fzrwvUwxaGJCfgLlshh1D
p=2,a=RS256,d=oqEQbfURn6qiTLkt4ePLetQaR4vZ1x6iQl9/LGiNB6BAYywLKJx9XZKZ65ciQSFPEw5QbAa6SKYYOCeee2/yujpyID6zbCzKxVRE4UbDPlmUn7OBkD9i79y4ZVlkm4p4wCyo6IrsIVYKOZL+IyZ9Amz+nndVd5zHuPcEH//bqB3f6pXAgShS
p=3,a=RS256,d=zeKCjNQEAukj08Vz6OcLSRc2EQIDAQAB
```

2. **Private key** goes in the API environment as `DOMAIN_CONNECT_PRIVATE_KEY` (never commit it).
3. **Submit the template** as a PR to https://github.com/Domain-Connect/Templates (file in the repo root).
   Their PR template requires a link from the online editor (https://domainconnect.paulonet.eu/dc/free/templateedit)
   showing tests for the apex and a subdomain.
4. Providers import merged templates on their own schedule. Until then the button reports "not supported".
