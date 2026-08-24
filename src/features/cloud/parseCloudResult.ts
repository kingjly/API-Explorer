import type { CloudResultKind } from "./presets";

export interface ResultColumn {
  key: string;
  label: string;
}

export interface ResultSummaryItem {
  label: string;
  value: string;
}

export interface ParsedCloudResult {
  title: string;
  summary: ResultSummaryItem[];
  columns: ResultColumn[];
  rows: Array<Record<string, string>>;
  error?: { code: string; message: string };
  parsed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function unwrapAliyunList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  const nested = Object.values(record).find((item) => Array.isArray(item) || asRecord(item));
  if (Array.isArray(nested)) return nested;
  return asRecord(nested) ? [nested] : [];
}

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const scalars = value.filter((item) => item == null || ["string", "number", "boolean"].includes(typeof item));
    if (scalars.length === value.length) return scalars.filter((item) => item != null && item !== "").map(String).join(", ");
    return value.length ? `${value.length} 项` : "";
  }
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["IpAddress", "ipAddress", "IpAddresses", "ipv4"]) {
    if (key in record) return text(record[key]);
  }
  return "";
}

function get(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function firstText(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    const value = text(record[key]);
    if (value) return value;
  }
  return "";
}

function pickPath(root: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const value = get(root, path);
    if (value != null && value !== "") return value;
  }
  return undefined;
}

function summaryFrom(root: unknown, fields: Array<{ label: string; paths: string[][] }>): ResultSummaryItem[] {
  return fields
    .map((field) => ({ label: field.label, value: text(pickPath(root, field.paths)) }))
    .filter((item) => item.value);
}

function detectError(root: unknown): ParsedCloudResult["error"] | undefined {
  const tencentError = asRecord(get(root, ["Response", "Error"]));
  if (tencentError) {
    return {
      code: firstText(tencentError, ["Code", "code"]) || "Error",
      message: firstText(tencentError, ["Message", "message"]),
    };
  }

  const volcError = asRecord(get(root, ["ResponseMetadata", "Error"]));
  if (volcError) {
    return {
      code: firstText(volcError, ["Code", "code"]) || "Error",
      message: firstText(volcError, ["Message", "message"]),
    };
  }

  const huaweiNested = asRecord(get(root, ["error"]));
  const huaweiCode = text(get(root, ["error_code"])) || firstText(huaweiNested, ["code", "Code"]);
  const huaweiMessage = text(get(root, ["error_msg"])) || firstText(huaweiNested, ["message", "Message"]);
  if (huaweiCode) return { code: huaweiCode, message: huaweiMessage };

  const record = asRecord(root);
  if (!record) return undefined;

  const aliyunCode = firstText(record, ["Code", "code"]);
  const aliyunMessage = firstText(record, ["Message", "message", "Msg"]);
  if (aliyunCode && !["OK", "ok", "Success", "success", "200"].includes(aliyunCode)) {
    if ("RequestId" in record || "requestId" in record || aliyunMessage) {
      return { code: aliyunCode, message: aliyunMessage };
    }
  }

  return undefined;
}

function mapRows(items: unknown[], mapper: (record: Record<string, unknown>) => Record<string, string>) {
  return items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map(mapper);
}

function collectLists(root: unknown, paths: string[][]): unknown[] {
  for (const path of paths) {
    const value = get(root, path);
    if (value == null) continue;
    const list = Array.isArray(value) ? value : unwrapAliyunList(value);
    if (list.length > 0) return list;
  }
  return [];
}

function parseMappedList(
  root: unknown,
  title: string,
  listPaths: string[][],
  columns: Array<{ key: string; label: string; fields: string[] }>,
): ParsedCloudResult {
  const rows = mapRows(collectLists(root, listPaths), (record) => {
    const row: Record<string, string> = {};
    for (const column of columns) row[column.key] = firstText(record, column.fields);
    return row;
  });
  return {
    title,
    parsed: true,
    error: detectError(root),
    summary: summaryFrom(root, [
      { label: "总数", paths: [["TotalCount"], ["Response", "TotalCount"], ["Result", "TotalCount"], ["Result", "Total"], ["count"], ["total_count"]] },
      { label: "RequestId", paths: [["RequestId"], ["Response", "RequestId"], ["ResponseMetadata", "RequestId"], ["requestId"], ["request_id"]] },
    ]),
    columns: columns.map(({ key, label }) => ({ key, label })),
    rows,
  };
}

function parseIdentity(root: unknown): ParsedCloudResult {
  return {
    title: "调用身份",
    parsed: true,
    error: detectError(root),
    summary: summaryFrom(root, [
      { label: "账号", paths: [["AccountId"], ["Response", "AccountId"], ["accountId"]] },
      { label: "用户 ID", paths: [["UserId"], ["Response", "UserId"], ["Response", "PrincipalId"], ["userId"]] },
      { label: "ARN", paths: [["Arn"], ["Response", "Arn"], ["arn"]] },
      { label: "类型", paths: [["IdentityType"], ["Response", "Type"], ["Type"]] },
      { label: "RequestId", paths: [["RequestId"], ["Response", "RequestId"], ["requestId"]] },
    ]),
    columns: [],
    rows: [],
  };
}

function parseInstanceList(root: unknown): ParsedCloudResult {
  const instances = collectLists(root, [
    ["Instances"],
    ["Response", "InstanceSet"],
    ["Result", "Instances"],
    ["instances"],
    ["servers"],
    ["cloudservers"],
    ["InstanceSet"],
  ]);

  const rows = mapRows(instances, (record) => ({
    id: firstText(record, ["InstanceId", "instanceId", "id", "Id"]),
    name: firstText(record, ["InstanceName", "instanceName", "name", "Name"]),
    status: firstText(record, ["Status", "status", "InstanceState", "instanceState", "state"]),
    type: firstText(record, ["InstanceType", "instanceType", "spec", "FlavorRef", "flavor_id"])
      || text(get(record, ["flavor", "id"]))
      || text(get(record, ["flavor", "name"])),
    zone: firstText(record, ["ZoneId", "zoneId", "zoneName"]) || text(get(record, ["Placement", "Zone"])),
    publicIp:
      text(get(record, ["PublicIpAddress"]))
      || text(record.PublicIpAddresses)
      || firstText(record, ["publicIp", "eip", "EipAddress"]),
    privateIp:
      text(get(record, ["VpcAttributes", "PrivateIpAddress"]))
      || text(get(record, ["NetworkInterfaces", "NetworkInterface", "0", "PrimaryIpAddress"]))
      || text(record.PrivateIpAddresses)
      || firstText(record, ["internalIp", "privateIp", "PrivateIpAddress"]),
  }));

  return {
    title: "实例",
    parsed: true,
    error: detectError(root),
    summary: summaryFrom(root, [
      { label: "总数", paths: [["TotalCount"], ["Response", "TotalCount"], ["totalCount"]] },
      { label: "页码", paths: [["PageNumber"], ["pageNumber"]] },
      { label: "页大小", paths: [["PageSize"], ["maxKeys"], ["PageSize"]] },
      { label: "RequestId", paths: [["RequestId"], ["Response", "RequestId"], ["requestId"]] },
    ]),
    columns: [
      { key: "id", label: "实例 ID" },
      { key: "name", label: "名称" },
      { key: "status", label: "状态" },
      { key: "type", label: "规格" },
      { key: "zone", label: "可用区" },
      { key: "publicIp", label: "公网 IP" },
      { key: "privateIp", label: "内网 IP" },
    ],
    rows,
  };
}

function parseSmsSend(root: unknown): ParsedCloudResult {
  const sendStatus = asArray(get(root, ["Response", "SendStatusSet"]));
  if (sendStatus.length > 0) {
    return {
      title: "短信发送",
      parsed: true,
      error: detectError(root),
      summary: summaryFrom(root, [
        { label: "RequestId", paths: [["Response", "RequestId"], ["RequestId"]] },
      ]),
      columns: [
        { key: "phone", label: "手机号" },
        { key: "status", label: "状态" },
        { key: "message", label: "说明" },
        { key: "serial", label: "流水号" },
        { key: "fee", label: "计费条数" },
      ],
      rows: mapRows(sendStatus, (record) => ({
        phone: firstText(record, ["PhoneNumber", "phoneNumber"]),
        status: firstText(record, ["Code", "code"]),
        message: firstText(record, ["Message", "message"]),
        serial: firstText(record, ["SerialNo", "serialNo", "Sid"]),
        fee: firstText(record, ["Fee", "fee"]),
      })),
    };
  }

  const record = asRecord(root) ?? {};
  const code = firstText(record, ["Code", "code"]);
  const ok = ["OK", "ok", "Success", "success"].includes(code);
  return {
    title: "短信发送",
    parsed: true,
    error: ok ? undefined : detectError(root) ?? (code ? { code, message: firstText(record, ["Message", "message"]) } : undefined),
    summary: summaryFrom(root, [
      { label: "状态", paths: [["Code"], ["code"]] },
      { label: "说明", paths: [["Message"], ["message"]] },
      { label: "业务流水", paths: [["BizId"], ["bizId"]] },
      { label: "RequestId", paths: [["RequestId"], ["requestId"]] },
    ]),
    columns: [],
    rows: [],
  };
}

const LIST_KIND_SPECS: Record<
  Exclude<CloudResultKind, "instanceList" | "smsSend" | "identity">,
  { title: string; listPaths: string[][]; columns: Array<{ key: string; label: string; fields: string[] }> }
> = {
  regionList: {
    title: "地域",
    listPaths: [["Regions"], ["Response", "RegionSet"], ["Result", "Regions"], ["regions"]],
    columns: [
      { key: "id", label: "地域", fields: ["RegionId", "Region", "regionId", "id", "Id"] },
      { key: "name", label: "名称", fields: ["LocalName", "RegionName", "regionName", "name", "Name"] },
      { key: "status", label: "状态", fields: ["RegionState", "RegionStatus", "status", "Status"] },
    ],
  },
  vpcList: {
    title: "VPC",
    listPaths: [["Vpcs"], ["Response", "VpcSet"], ["Result", "Vpcs"], ["vpcs"], ["vpc"]],
    columns: [
      { key: "id", label: "VPC ID", fields: ["VpcId", "vpcId", "id", "Id"] },
      { key: "name", label: "名称", fields: ["VpcName", "vpcName", "name", "Name"] },
      { key: "status", label: "状态", fields: ["Status", "status"] },
      { key: "cidr", label: "网段", fields: ["CidrBlock", "cidrBlock", "cidr", "cidr_block"] },
    ],
  },
  subnetList: {
    title: "子网",
    listPaths: [["VSwitches"], ["Response", "SubnetSet"], ["Result", "Subnets"], ["subnets"], ["subnet"]],
    columns: [
      { key: "id", label: "子网 ID", fields: ["VSwitchId", "SubnetId", "subnetId", "id", "Id"] },
      { key: "name", label: "名称", fields: ["VSwitchName", "SubnetName", "subnetName", "name", "Name"] },
      { key: "cidr", label: "网段", fields: ["CidrBlock", "cidrBlock", "cidr"] },
      { key: "zone", label: "可用区", fields: ["ZoneId", "Zone", "zoneId", "availability_zone"] },
      { key: "vpc", label: "VPC", fields: ["VpcId", "vpcId"] },
    ],
  },
  securityGroupList: {
    title: "安全组",
    listPaths: [["SecurityGroups"], ["Response", "SecurityGroupSet"], ["Result", "SecurityGroups"], ["security_groups"], ["securityGroups"]],
    columns: [
      { key: "id", label: "安全组 ID", fields: ["SecurityGroupId", "securityGroupId", "id", "Id"] },
      { key: "name", label: "名称", fields: ["SecurityGroupName", "securityGroupName", "name", "Name"] },
      { key: "vpc", label: "VPC", fields: ["VpcId", "vpcId"] },
      { key: "description", label: "描述", fields: ["Description", "description"] },
    ],
  },
  rdsList: {
    title: "数据库实例",
    listPaths: [["Items"], ["Response", "Items"], ["Result", "Instances"], ["instances"], ["DBInstances"]],
    columns: [
      { key: "id", label: "实例 ID", fields: ["DBInstanceId", "InstanceId", "instanceId", "id", "Id"] },
      { key: "name", label: "名称", fields: ["DBInstanceDescription", "InstanceName", "instanceName", "name", "Name"] },
      { key: "status", label: "状态", fields: ["DBInstanceStatus", "Status", "status"] },
      { key: "engine", label: "引擎", fields: ["Engine", "engine"] },
      { key: "version", label: "版本", fields: ["EngineVersion", "engineVersion"] },
      { key: "class", label: "规格", fields: ["DBInstanceClass", "Memory", "spec"] },
    ],
  },
  iamUserList: {
    title: "IAM 用户",
    listPaths: [["Users"], ["Response", "Data"], ["Result", "Users"], ["users"], ["user"]],
    columns: [
      { key: "name", label: "用户名", fields: ["UserName", "userName", "Name", "name"] },
      { key: "display", label: "显示名", fields: ["DisplayName", "displayName", "NickName"] },
      { key: "id", label: "用户 ID", fields: ["UserId", "Uid", "id", "Id"] },
      { key: "created", label: "创建时间", fields: ["CreateDate", "createDate", "CreatedDate", "CreateTime"] },
    ],
  },
  iamRoleList: {
    title: "IAM 角色",
    listPaths: [["Roles"], ["Response", "RoleInfo"], ["Result", "RoleMetadata"], ["roles"]],
    columns: [
      { key: "name", label: "角色名", fields: ["RoleName", "roleName", "Name", "name"] },
      { key: "arn", label: "ARN", fields: ["Arn", "arn", "RoleId"] },
      { key: "id", label: "角色 ID", fields: ["RoleId", "id", "Id"] },
      { key: "created", label: "创建时间", fields: ["CreateDate", "createDate", "AddTime"] },
    ],
  },
  domainList: {
    title: "域名",
    listPaths: [["Domains"], ["Response", "DomainList"], ["zones"], ["domainList"]],
    columns: [
      { key: "name", label: "域名", fields: ["DomainName", "Name", "name", "Punycode"] },
      { key: "id", label: "ID", fields: ["DomainId", "id", "Id"] },
      { key: "status", label: "状态", fields: ["DomainStatus", "Status", "status"] },
      { key: "type", label: "类型", fields: ["VersionCode", "zone_type", "Grade"] },
    ],
  },
  loadBalancerList: {
    title: "负载均衡",
    listPaths: [["LoadBalancers"], ["Response", "LoadBalancerSet"], ["blb"], ["loadbalancers"]],
    columns: [
      { key: "id", label: "实例 ID", fields: ["LoadBalancerId", "loadBalancerId", "id", "Id", "blbId"] },
      { key: "name", label: "名称", fields: ["LoadBalancerName", "loadBalancerName", "name", "Name"] },
      { key: "status", label: "状态", fields: ["LoadBalancerStatus", "Status", "status"] },
      { key: "address", label: "地址", fields: ["Address", "address", "vip"] },
      { key: "type", label: "类型", fields: ["AddressType", "LoadBalancerType", "type"] },
    ],
  },
  diskList: {
    title: "云盘",
    listPaths: [["Disks"], ["Response", "DiskSet"], ["volumes"], ["volume"]],
    columns: [
      { key: "id", label: "云盘 ID", fields: ["DiskId", "id", "Id"] },
      { key: "name", label: "名称", fields: ["DiskName", "name", "Name"] },
      { key: "status", label: "状态", fields: ["Status", "status"] },
      { key: "size", label: "容量", fields: ["Size", "DiskSize", "sizeInGB"] },
      { key: "type", label: "类型", fields: ["Type", "DiskType", "category", "storageType"] },
      { key: "instance", label: "挂载实例", fields: ["InstanceId", "instanceId"] },
    ],
  },
  projectList: {
    title: "项目",
    listPaths: [["projects"]],
    columns: [
      { key: "id", label: "项目 ID", fields: ["id", "Id"] },
      { key: "name", label: "名称", fields: ["name", "Name"] },
      { key: "enabled", label: "启用", fields: ["enabled"] },
      { key: "domain", label: "租户", fields: ["domain_id"] },
    ],
  },
  eipList: {
    title: "弹性公网 IP",
    listPaths: [["EipAddresses"], ["Response", "AddressSet"], ["Result", "EipAddresses"], ["publicips"], ["eipList"], ["eip"]],
    columns: [
      { key: "id", label: "EIP ID", fields: ["AllocationId", "AddressId", "id", "Id", "eipId"] },
      { key: "ip", label: "地址", fields: ["IpAddress", "AddressIp", "public_ip_address", "eip"] },
      { key: "status", label: "状态", fields: ["Status", "status"] },
      { key: "instance", label: "绑定实例", fields: ["InstanceId", "instanceId"] },
      { key: "bandwidth", label: "带宽", fields: ["Bandwidth", "bandwidth", "InternetMaxBandwidthOut"] },
    ],
  },
};

function parseGeneric(root: unknown): ParsedCloudResult {
  const record = asRecord(root);
  const nested = asRecord(get(root, ["Response"])) ?? asRecord(get(root, ["Result"])) ?? record;
  const arrayEntry = nested
    ? Object.entries(nested).find(([, value]) => Array.isArray(value) && (value as unknown[]).some(asRecord))
    : undefined;
  const items = arrayEntry ? asArray(arrayEntry[1]) : [];
  const sample = asRecord(items[0]);
  const scalarKeys = sample
    ? Object.keys(sample).filter((key) => ["string", "number", "boolean"].includes(typeof sample[key])).slice(0, 7)
    : [];

  return {
    title: arrayEntry ? arrayEntry[0] : "响应字段",
    parsed: true,
    error: detectError(root),
    summary: nested
      ? Object.entries(nested)
          .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
          .slice(0, 8)
          .map(([label, value]) => ({ label, value: String(value) }))
      : [],
    columns: scalarKeys.map((key) => ({ key, label: key })),
    rows: mapRows(items, (item) => {
      const row: Record<string, string> = {};
      for (const key of scalarKeys) row[key] = text(item[key]);
      return row;
    }),
  };
}

export function parseCloudResult(body: string, kind: CloudResultKind): ParsedCloudResult {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return {
      title: "响应",
      parsed: false,
      summary: [],
      columns: [],
      rows: [],
    };
  }

  switch (kind) {
    case "instanceList":
      return parseInstanceList(root);
    case "smsSend":
      return parseSmsSend(root);
    case "identity":
      return parseIdentity(root);
    default: {
      const spec = LIST_KIND_SPECS[kind];
      return spec
        ? parseMappedList(root, spec.title, spec.listPaths, spec.columns)
        : parseGeneric(root);
    }
  }
}

export function formatJson(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function statusToneClass(status: string) {
  const value = status.toLowerCase();
  if (["running", "ok", "active", "available", "success", "online"].includes(value)) return "running";
  if (["stopped", "stop", "offline", "inactive", "pending", "building"].includes(value)) return "stopped";
  if (["error", "failed", "fail", "deleted", "terminated", "denied"].includes(value) || value.includes("fail")) {
    return "error";
  }
  return "";
}
