# EC2 개발 환경 수동 배포

BEA-162. 모노레포 루트에서 웹과 API 이미지를 빌드한다. 웹 컨테이너의 Caddy가 React 빌드 결과를 제공하고 `/api/*`를 내부 NestJS 컨테이너로 전달한다. NestJS만 기존 비공개 RDS에 연결한다.

## 1. DB와 환경 변수 준비

SSM으로 개발 EC2에 접속한 뒤 아래 명령은 레포 루트에서 실행한다. 팀에서 배포하기로 한 Git 커밋을 체크아웃한다.

```bash
docker version
docker compose version
curl -fsS https://truststore.pki.rds.amazonaws.com/ap-northeast-2/ap-northeast-2-bundle.pem \
  -o deploy/rds-ca.pem
chmod 644 deploy/rds-ca.pem
umask 077
touch .env.dev-server
chmod 600 .env.dev-server
```

RDS에서 사용할 dev 데이터베이스 이름을 확인하고, 스키마를 소유하는 마이그레이션 계정과 별도로 앱 계정을 준비한다. 아래 SQL은 역할이 없는 신규 dev DB의 첫 설정 예시다. 권한 있는 DB 계정으로 `psql`에 접속해 실행한다. 이미 역할이 있으면 속성과 권한을 확인하고 재사용한다.

```sql
CREATE ROLE bv_app NOLOGIN;
CREATE ROLE bv_dev_app LOGIN;
GRANT bv_app TO bv_dev_app;
\password bv_dev_app
```

`.env.dev-server`에 서버에서 사용할 아래 값을 입력한다. 접속 URL의 비밀번호 부분에 예약 문자가 있으면 URL 인코딩한다. 마이그레이션 계정 접속 URL은 이 파일과 앱에 두지 않는다.

```dotenv
DATABASE_URL=postgresql://bv_dev_app:APP_PASSWORD@RDS_HOST:5432/DB_NAME?sslmode=verify-full&sslrootcert=/run/rds-ca.pem
KAKAO_CLIENT_ID=
KAKAO_CLIENT_SECRET=
KAKAO_REDIRECT_URI=
BV_SESSION_SECRET=
```

`BV_SESSION_SECRET`은 `openssl rand -hex 32`로 생성한다. 도메인이 아직 없으면 카카오 설정은 비워둔 채 EC2 내부에서 웹과 API 기동을 먼저 확인할 수 있다.

## 2. 빌드와 DB 마이그레이션

```bash
docker compose -f compose.dev-server.yaml build
read -rsp 'Migration DB URL: ' DATABASE_MIGRATION_URL
printf '\n'
export DATABASE_MIGRATION_URL
docker compose -f compose.dev-server.yaml run --rm --no-deps \
  -e DATABASE_MIGRATION_URL api node db/migrate.cjs
unset DATABASE_MIGRATION_URL
```

마이그레이션 URL도 RDS 엔드포인트와 `sslmode=verify-full&sslrootcert=/run/rds-ca.pem`을 사용한다. 마이그레이션 성공을 확인한 뒤 앱을 실행한다.

```bash
docker compose -f compose.dev-server.yaml up -d --wait
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/login >/dev/null
```

## 3. HTTPS와 카카오 시연

팀 dev 도메인을 EC2 주소에 연결하고 인바운드는 웹 포트 80·443을 대상으로 설정한다. RDS와 NestJS는 내부에서 접근한다. 아래 예시의 주소를 팀 도메인으로 바꾸고 카카오 앱의 리다이렉트 URI와 `.env.dev-server`의 `KAKAO_REDIRECT_URI`를 모두 `https://dev.example.com/api/auth/kakao/callback`으로 맞춘다.

같은 카카오 개발 앱의 로그인 확인에서 얻은 시연 원장의 서비스 사용자 ID를 사용해 합성 매장과 설정을 dev DB에 만든다. 동일 계정으로 재실행할 수 있으며 이미 연결된 다른 원장을 교체하지 않는다. ID와 마이그레이션 URL은 프롬프트로 입력한다.

```bash
read -rsp 'Migration DB URL: ' DATABASE_MIGRATION_URL
printf '\n'
read -rsp 'Verified Kakao user ID: ' BV_DEV_KAKAO_USER_ID
printf '\n'
export DATABASE_MIGRATION_URL BV_DEV_KAKAO_USER_ID
docker compose -f compose.dev-server.yaml run --rm --no-deps \
  -e DATABASE_MIGRATION_URL -e BV_DEV_KAKAO_USER_ID api node db/seed-dev-owner.cjs
unset DATABASE_MIGRATION_URL BV_DEV_KAKAO_USER_ID
```

```bash
export BV_WEB_SITE_ADDRESS=dev.example.com
export BV_WEB_BIND_ADDRESS=0.0.0.0
export BV_WEB_HTTP_PORT=80
export BV_WEB_HTTPS_PORT=443
docker compose -f compose.dev-server.yaml up -d --wait
curl -fsS https://dev.example.com/api/health
```

브라우저에서 로그인 성공 후 시연 매장 조회와 다른 매장 조회 거부를 확인한다. 재배포에도 같은 공개 주소·포트 설정을 사용한다. 장애 시 `docker compose -f compose.dev-server.yaml ps`와 `docker compose -f compose.dev-server.yaml logs --tail=100 api web`으로 어느 서비스에서 실패했는지 확인한다.
