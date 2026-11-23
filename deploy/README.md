# EC2 개발 환경 수동 배포

BEA-162. 모노레포 루트에서 웹과 API 이미지를 빌드한다. 웹 컨테이너의 Caddy가 React 빌드 결과를 제공하고 `/api/*`를 내부 NestJS 컨테이너로 전달한다. NestJS만 기존 비공개 RDS에 연결한다.

## 1. DB와 환경 변수 준비

SSM으로 개발 EC2에 접속한 뒤 레포 루트에서 Bash를 열고 순서대로 실행한다. 팀에서 배포하기로 한 Git 커밋을 체크아웃한다. Docker 명령은 `sudo`로 실행한다.

Compose 프로젝트 이름은 `beautifulvoice-dev`다. 릴리스 경로가 바뀌어도 기존 스택을 갱신하도록 배포할 때 이 이름을 사용한다.

```bash
sudo docker version
sudo docker compose version
compose=(sudo docker compose -f compose.dev-server.yaml)
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
BV_OWNER_CONSENT_VERSION=
BV_OWNER_CONSENT_TEXT=
```

`BV_SESSION_SECRET`은 `openssl rand -hex 32`로 생성한다. `BV_OWNER_CONSENT_VERSION`과 `BV_OWNER_CONSENT_TEXT`에는 팀에서 확정한 동의 버전과 문구를 함께 입력한다. 한 값이라도 비어 있으면 배포 환경의 로그인과 인증된 CRM 요청은 `503`을 반환한다. 도메인이나 동의 문구가 준비되기 전에도 EC2 내부 헬스 체크는 실행할 수 있다.

## 2. 빌드와 DB 마이그레이션

```bash
"${compose[@]}" build
read -rsp 'Migration DB URL: ' migration_url
printf '\n'
printf '%s' "$migration_url" | "${compose[@]}" run --rm -T --no-deps api \
  node -e 'process.env.DATABASE_MIGRATION_URL = require("node:fs").readFileSync(0, "utf8"); require("./db/migrate.cjs")'
unset migration_url
```

마이그레이션 URL도 RDS 엔드포인트와 `sslmode=verify-full&sslrootcert=/run/rds-ca.pem`을 사용한다. URL은 일회성 컨테이너의 표준 입력으로 전달한다. 마이그레이션 성공을 확인한 뒤 앱을 실행한다.

```bash
"${compose[@]}" up -d --wait
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/login >/dev/null
```

## 3. HTTPS와 카카오 시연

팀 dev 도메인을 EC2 주소에 연결하고 인바운드는 웹 포트 80·443을 대상으로 설정한다. RDS와 NestJS는 내부에서 접근한다. 아래 예시의 주소를 팀 도메인으로 바꾸고 카카오 앱의 리다이렉트 URI와 `.env.dev-server`의 `KAKAO_REDIRECT_URI`를 모두 `https://dev.example.com/api/auth/kakao/callback`으로 맞춘다.

브라우저 로그인 검증 전에 API 컨테이너가 동의 설정을 모두 읽는지 확인한다. 이 명령은 값의 내용을 출력하지 않는다.

```bash
"${compose[@]}" run --rm -T --no-deps --entrypoint node api -e '
  for (const key of ["BV_OWNER_CONSENT_VERSION", "BV_OWNER_CONSENT_TEXT"]) {
    if (!process.env[key]?.trim()) {
      console.error(key + " is required");
      process.exitCode = 1;
    }
  }
'
```

### 시연 원장 ID 확인

로컬 PC에서 [로컬 카카오 로그인](../README.md#로컬-카카오-로그인) 절차에 따라 로컬 DB를 마이그레이션하고, `pnpm --filter @bv/server db:register-local-owner`로 시연에 쓸 카카오 계정을 등록한다. 로컬과 dev의 `KAKAO_CLIENT_ID`는 같은 카카오 앱의 REST API 키를 사용하고, 콜백은 각각의 주소를 사용한다.

브라우저에서 원장 등록 성공을 확인한 후, 로컬 레포 루트에서 등록 스크립트가 연결한 합성 매장의 서비스 사용자 ID를 조회한다. 아래 명령은 로컬 Compose DB 기본 설정 기준이다.

```bash
docker compose exec -T db psql -U bv_local -d beautifulvoice -Atc \
  "SELECT kakao_user_id FROM crm.user_membership WHERE shop_id = 'ee3fe317-c214-446f-82c2-c209cc4eafa1' AND kakao_user_id IS NOT NULL"
```

숫자 한 줄이 나오면 아래 `Verified Kakao user ID` 프롬프트에 입력한다. 결과가 비어 있으면 로컬 원장 등록이 성공했는지 확인한다. ID는 터미널에서만 확인한다.

### dev DB에 시연 원장 등록

확인한 서비스 사용자 ID로 dev DB에 합성 매장과 설정을 만든다. 동일 계정으로 재실행할 수 있으며 이미 연결된 다른 원장을 교체하지 않는다. ID와 마이그레이션 URL은 프롬프트로 입력한다.

```bash
read -rsp 'Migration DB URL: ' migration_url
printf '\n'
read -rsp 'Verified Kakao user ID: ' kakao_user_id
printf '\n'
printf '%s\n%s' "$migration_url" "$kakao_user_id" | "${compose[@]}" run --rm -T --no-deps api \
  node -e 'const [url, id] = require("node:fs").readFileSync(0, "utf8").split("\n"); process.env.DATABASE_MIGRATION_URL = url; process.env.BV_DEV_KAKAO_USER_ID = id; require("./db/seed-dev-owner.cjs")'
unset migration_url kakao_user_id
```

```bash
sudo env BV_WEB_SITE_ADDRESS=dev.example.com BV_WEB_BIND_ADDRESS=0.0.0.0 \
  BV_WEB_HTTP_PORT=80 BV_WEB_HTTPS_PORT=443 \
  docker compose -f compose.dev-server.yaml up -d --wait
curl -fsS https://dev.example.com/api/health
```

브라우저에서 카카오 로그인 후 최초 동의 문구가 표시되는지 확인한다. 동의를 저장하면 시연 매장이 열리고, 새로고침해도 동의 화면이 다시 뜨지 않아야 한다. 다른 매장 조회도 거부되는지 확인한다. 재배포에도 같은 공개 주소·포트 설정을 사용한다. 장애 시 `"${compose[@]}" ps`와 `"${compose[@]}" logs --tail=100 api web`으로 어느 서비스에서 실패했는지 확인한다.

Caddy 접근 로그를 켜는 경우 고객 목록 요청의 `q`와 `cursor` 쿼리 값을 로그에서 가린다. 검색어와 페이지 커서에는 고객 이름이나 전화번호가 포함될 수 있다.
