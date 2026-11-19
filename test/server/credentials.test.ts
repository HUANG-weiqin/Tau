// tau 自己的凭据文件（D83）。测试内容在 test/credential-suite.ts，和 extras/auth/store.ts 共用。
import { credentialSuite } from "../credential-suite.ts";
import { fileCredentials } from "../../src/server/credentials.ts";

credentialSuite("src", fileCredentials, new URL("../../src/server/credentials.ts", import.meta.url));
