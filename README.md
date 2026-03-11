# Create User With SSO Lambda

Lambda nay xu ly JIT provisioning cho user dang nhap SSO qua Cognito (Duo), muc tieu la dam bao bang `users` trong DB luon co data de admin portal query duoc.

## Flow chinh

1. Cognito trigger `PostAuthentication` goi Lambda sau khi user login thanh cong.
2. Lambda doc claims (`sub`, `email`, `name`, `preferred_username`).
3. Lambda lay groups trong Cognito (`AdminListGroupsForUser`) de map role:
   - co group `Admin`/`ADMIN` -> `ADMIN`
   - nguoc lai -> `USER`
4. Lambda upsert vao bang `users`:
   - uu tien tim theo `id = sub`
   - neu khong co, tim theo `email`
   - neu trung email va `ALLOW_EMAIL_LINK=true` -> update row theo email
   - neu trung email va `ALLOW_EMAIL_LINK=false` -> skip (hoac fail neu `FAIL_ON_ERROR=true`)

## 1) Cai dat

Yeu cau:

- Node.js 20+
- AWS CLI da login va co quyen deploy Lambda/IAM/CloudFormation

Lenh:

```bash
npm install
```

## 2) Chay local

Smoke test:

```bash
npm run invoke
```

Gia lap Cognito PostAuthentication:

```bash
DB_HOST=127.0.0.1 \
DB_PORT=3306 \
DB_NAME=somos_stg_db \
DB_USERNAME=root \
DB_PASSWORD=your_password \
COGNITO_REGION=us-east-2 \
npm run invoke:cognito
```

## 3) Deploy

Staging:

```bash
DB_HOST=... DB_PORT=3306 DB_NAME=... DB_USERNAME=... DB_PASSWORD=... \
COGNITO_REGION=us-east-2 \
ALLOW_EMAIL_LINK=false FAIL_ON_ERROR=false \
npm run deploy:stg
```

Production:

```bash
DB_HOST=... DB_PORT=3306 DB_NAME=... DB_USERNAME=... DB_PASSWORD=... \
COGNITO_REGION=us-east-2 \
ALLOW_EMAIL_LINK=false FAIL_ON_ERROR=false \
npm run deploy:prod
```

## 4) Gan trigger vao Cognito User Pool

Voi existing user pool, nen gan trigger sau khi deploy:

```bash
aws cognito-idp update-user-pool \
  --user-pool-id <USER_POOL_ID> \
  --lambda-config PostAuthentication=<LAMBDA_ARN>
```

Hoac gan trong AWS Console: Cognito User Pool -> Lambda triggers -> Post authentication.

## 5) Bien moi truong

- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`: ket noi MySQL
- `COGNITO_REGION`: region user pool
- `DB_POOL_MAX`: mac dinh `5`
- `ALLOW_EMAIL_LINK`: mac dinh `false`, bat len khi muon merge user theo email
- `FAIL_ON_ERROR`: mac dinh `false`, bat len neu muon block login khi provision fail

## 6) Luu y theo schema hien tai

Bang `users` dang unique theo `email`, `username`, `phone`; `id` dang dung `sub` trong luong local user. Lambda nay giu nguyen convention do de tuong thich voi backend hien tai.
