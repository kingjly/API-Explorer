export type CloudFailureKind =
  | "expired"
  | "invalid_key"
  | "bad_signature"
  | "need_token"
  | "denied"
  | "wrong_region"
  | "cancelled"
  | "other";

export interface CloudFailureExplain {
  kind: CloudFailureKind;
  title: string;
  hint: string;
}

const RULES: Array<{ kind: CloudFailureKind; needles: string[] }> = [
  { kind: "cancelled", needles: ["cancelled", "canceled", "已取消"] },
  {
    kind: "expired",
    needles: [
      "expiredtoken",
      "securitytokenexpired",
      "invalidsecuritytoken.expired",
      "tokenexpired",
      "expiredsecuritytoken",
      "authfailure.tokenfailure",
      "expired",
      "已过期",
      "10002",
      "accesstoken异常",
    ],
  },
  {
    kind: "need_token",
    needles: [
      "missingsecuritytoken",
      "invalidsecuritytoken",
      "securitytokenmalformed",
      "incompletesecuritytoken",
      "need token",
    ],
  },
  {
    kind: "invalid_key",
    needles: [
      "invalidaccesskeyid",
      "secretidnotfound",
      "invalidaccesskey",
      "unknownaccesskey",
      "accesskeyidnotfound",
      "notexist.accesskey",
      "inactiveaccesskey",
      "10005",
      "10013",
      "appkey异常",
      "appkey和appsecret不匹配",
    ],
  },
  {
    kind: "bad_signature",
    needles: [
      "signaturedoesnotmatch",
      "signaturefailure",
      "authfailure.signaturefailure",
      "incompletesignature",
      "invalidsignature",
      "bad token",
      "incorrect padding",
    ],
  },
  {
    kind: "wrong_region",
    needles: ["invalidregion", "unknownregion", "regionnotfound", "invalidparameter.region", "不支持该地域"],
  },
  {
    kind: "denied",
    needles: [
      "accessdenied",
      "unauthorizedoperation",
      "forbidden",
      "nopermission",
      "notauthorized",
      "permissiondenied",
      "authfailure.unauthorizedoperation",
      "forbidden.ram",
      "no permission",
    ],
  },
];

const COPY: Record<CloudFailureKind, CloudFailureExplain> = {
  expired: {
    kind: "expired",
    title: "临时凭据已过期",
    hint: "重新签发 STS 并粘贴整段 JSON，不必改接口。",
  },
  invalid_key: {
    kind: "invalid_key",
    title: "AccessKey 无效",
    hint: "ID 不存在或已停用。核对是否贴错，或换一把未禁用的密钥。",
  },
  bad_signature: {
    kind: "bad_signature",
    title: "签名对不上",
    hint: "多半是 Secret 与 ID 不是一对，或 STS 少了 Token。重新粘贴整段凭据。",
  },
  need_token: {
    kind: "need_token",
    title: "这是临时密钥，还缺 Token",
    hint: "把 AssumeRole / GetFederationToken 返回的 SecurityToken 一并贴上。",
  },
  denied: {
    kind: "denied",
    title: "当前密钥没有这个接口的权限",
    hint: "密钥本身可用，只是这一个操作被拒绝。换只读接口，或找账号加权限。不会去扫其他产品。",
  },
  wrong_region: {
    kind: "wrong_region",
    title: "这个地域不对",
    hint: "换顶栏地域再查一次，不必改密钥。",
  },
  cancelled: {
    kind: "cancelled",
    title: "已取消",
    hint: "请求已停下，可以改参数后再查。",
  },
  other: {
    kind: "other",
    title: "云 API 没有返回结果",
    hint: "先看厂商错误码。仍像权限问题时，换一个只读查询核对密钥是否可用。",
  },
};

function haystack(parts: Array<string | undefined>) {
  return parts.filter(Boolean).join("\n").toLowerCase();
}

export function explainCloudFailure(input: {
  code?: string;
  message?: string;
  body?: string;
  httpStatus?: number;
}): CloudFailureExplain {
  const text = haystack([input.code, input.message, input.body?.slice(0, 2000)]);
  const matched = RULES.find((rule) => rule.needles.some((needle) => text.includes(needle.toLowerCase())));
  if (matched) return COPY[matched.kind];
  if (input.httpStatus === 401 || input.httpStatus === 403) return COPY.denied;
  if (input.code === "cancelled") return COPY.cancelled;
  if (input.code || input.message) {
    return {
      ...COPY.other,
      title: input.code || COPY.other.title,
      hint: input.message || COPY.other.hint,
    };
  }
  return COPY.other;
}
