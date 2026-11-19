// extras/auth/store.ts 是 src/server/credentials.ts 的拷贝（extras 不许导入 src）。同一套测试，拷贝漂移了会红。
import { credentialSuite } from "../../credential-suite.ts";
import { fileCredentials } from "../../../extras/auth/store.ts";

credentialSuite("extras", fileCredentials, new URL("../../../extras/auth/store.ts", import.meta.url));
