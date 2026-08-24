import type { CloudProvider } from "../../types";

export type CloudResultKind =
  | "identity"
  | "instanceList"
  | "smsSend"
  | "regionList"
  | "vpcList"
  | "subnetList"
  | "securityGroupList"
  | "rdsList"
  | "iamUserList"
  | "iamRoleList"
  | "domainList"
  | "loadBalancerList"
  | "diskList"
  | "projectList"
  | "eipList"
  | "deviceList"
  | "cameraList"
  | "liveList"
  | "geoResult"
  | "poiList"
  | "bucketNameList"
  | "bucketInfo"
  | "uploadRegion"
  | "objectList";

export interface CloudPreset {
  id: string;
  label: string;
  product: string;
  provider: CloudProvider;
  method: string;
  endpoint: string;
  service: string;
  action: string;
  version: string;
  region: string;
  query: string;
  body: string;
  contentType: string;
  description: string;
  resultKind: CloudResultKind;
  risk?: "write";
}

export const PROVIDER_ORDER: CloudProvider[] = [
  "alibabaAcs3",
  "tencentTc3",
  "huaweiSdkHmac",
  "volcengineHmac",
  "baiduBceV1",
  "ezvizLapp",
  "tiandituTk",
  "qiniuMac",
];

export const PROVIDERS: Record<CloudProvider, { name: string; algorithm: string; domain: string }> = {
  alibabaAcs3: { name: "阿里云", algorithm: "ACS3", domain: "aliyuncs.com" },
  tencentTc3: { name: "腾讯云", algorithm: "TC3", domain: "tencentcloudapi.com" },
  huaweiSdkHmac: { name: "华为云", algorithm: "SDK-HMAC", domain: "myhuaweicloud.com" },
  volcengineHmac: { name: "火山引擎", algorithm: "HMAC-SHA256", domain: "volcengineapi.com" },
  baiduBceV1: { name: "百度智能云", algorithm: "BCE V1", domain: "baidubce.com" },
  ezvizLapp: { name: "萤石云", algorithm: "LAPP Form", domain: "open.ys7.com" },
  tiandituTk: { name: "天地图", algorithm: "tk", domain: "api.tianditu.gov.cn" },
  qiniuMac: { name: "七牛云", algorithm: "Qiniu MAC", domain: "qiniuapi.com" },
};

const JSON_UTF8 = "application/json; charset=utf-8";
const PAGE10 = "{\n  \"Limit\": 10,\n  \"Offset\": 0\n}";
const EMPTY_JSON = "{}";

function acs(
  id: string,
  product: string,
  label: string,
  action: string,
  version: string,
  host: string,
  query: string,
  resultKind: CloudResultKind,
  description: string,
  extras: Partial<CloudPreset> = {},
): CloudPreset {
  return {
    id,
    product,
    label,
    provider: "alibabaAcs3",
    method: "POST",
    endpoint: `https://${host}`,
    service: "",
    action,
    version,
    region: query.includes("RegionId=") ? "cn-hangzhou" : "",
    query,
    body: "",
    contentType: JSON_UTF8,
    description,
    resultKind,
    ...extras,
  };
}

function tc3(
  id: string,
  product: string,
  label: string,
  service: string,
  action: string,
  version: string,
  resultKind: CloudResultKind,
  description: string,
  body = PAGE10,
  extras: Partial<CloudPreset> = {},
): CloudPreset {
  return {
    id,
    product,
    label,
    provider: "tencentTc3",
    method: "POST",
    endpoint: `https://${service}.tencentcloudapi.com`,
    service,
    action,
    version,
    region: "ap-guangzhou",
    query: "",
    body,
    contentType: JSON_UTF8,
    description,
    resultKind,
    ...extras,
  };
}

function huawei(
  id: string,
  product: string,
  label: string,
  endpoint: string,
  resultKind: CloudResultKind,
  description: string,
  query = "limit=10",
): CloudPreset {
  return {
    id,
    product,
    label,
    provider: "huaweiSdkHmac",
    method: "GET",
    endpoint,
    service: "",
    action: "",
    version: "",
    region: "",
    query,
    body: "",
    contentType: "application/json",
    description,
    resultKind,
  };
}

function volc(
  id: string,
  product: string,
  label: string,
  service: string,
  action: string,
  version: string,
  resultKind: CloudResultKind,
  description: string,
  query = "MaxResults=10",
  extras: Partial<CloudPreset> = {},
): CloudPreset {
  return {
    id,
    product,
    label,
    provider: "volcengineHmac",
    method: "GET",
    endpoint: `https://${service}.volcengineapi.com`,
    service,
    action,
    version,
    region: "cn-beijing",
    query,
    body: "",
    contentType: "application/x-www-form-urlencoded; charset=utf-8",
    description,
    resultKind,
    ...extras,
  };
}

function bce(
  id: string,
  product: string,
  label: string,
  endpoint: string,
  resultKind: CloudResultKind,
  description: string,
  query = "maxKeys=10",
): CloudPreset {
  return {
    id,
    product,
    label,
    provider: "baiduBceV1",
    method: "GET",
    endpoint,
    service: "",
    action: "",
    version: "",
    region: "",
    query,
    body: "",
    contentType: JSON_UTF8,
    description,
    resultKind,
  };
}

function ezviz(
  id: string,
  product: string,
  label: string,
  path: string,
  resultKind: CloudResultKind,
  description: string,
  body = "pageStart=0&pageSize=10",
): CloudPreset {
  return {
    id,
    product,
    label,
    provider: "ezvizLapp",
    method: "POST",
    endpoint: `https://open.ys7.com${path}`,
    service: "",
    action: id.replace("ezviz-", "").replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    version: "",
    region: "",
    query: "",
    body,
    contentType: "application/x-www-form-urlencoded",
    description,
    resultKind,
  };
}

function tdt(
  id: string,
  product: string,
  label: string,
  path: string,
  query: string,
  resultKind: CloudResultKind,
  description: string,
): CloudPreset {
  return {
    id,
    product,
    label,
    provider: "tiandituTk",
    method: "GET",
    endpoint: `https://api.tianditu.gov.cn${path}`,
    service: "",
    action: "",
    version: "",
    region: "",
    query,
    body: "",
    contentType: "application/json",
    description,
    resultKind,
  };
}

function qiniu(
  id: string,
  product: string,
  label: string,
  endpoint: string,
  query: string,
  resultKind: CloudResultKind,
  description: string,
  action = "",
): CloudPreset {
  return {
    id,
    product,
    label,
    provider: "qiniuMac",
    method: "GET",
    endpoint,
    service: "",
    action,
    version: "",
    region: "",
    query,
    body: "",
    contentType: "application/x-www-form-urlencoded",
    description,
    resultKind,
  };
}

export const PRESETS: CloudPreset[] = [
  acs("aliyun-sts-identity", "STS", "校验身份", "GetCallerIdentity", "2015-04-01", "sts.aliyuncs.com", "", "identity", "确认当前 AK 对应的账号与 ARN"),
  acs("aliyun-ecs-regions", "ECS", "查询地域", "DescribeRegions", "2014-05-26", "ecs.aliyuncs.com", "", "regionList", "列出账号可访问的 ECS 地域"),
  acs("aliyun-ecs-list", "ECS", "查询实例", "DescribeInstances", "2014-05-26", "ecs.aliyuncs.com", "RegionId=cn-hangzhou&PageSize=10", "instanceList", "业务参数放在 Query"),
  acs("aliyun-ecs-sg", "ECS", "查询安全组", "DescribeSecurityGroups", "2014-05-26", "ecs.aliyuncs.com", "RegionId=cn-hangzhou&PageSize=10", "securityGroupList", "当前地域安全组"),
  acs("aliyun-ecs-disks", "ECS", "查询云盘", "DescribeDisks", "2014-05-26", "ecs.aliyuncs.com", "RegionId=cn-hangzhou&PageSize=10", "diskList", "系统盘与数据盘"),
  acs("aliyun-vpc-list", "VPC", "查询专有网络", "DescribeVpcs", "2016-04-28", "vpc.aliyuncs.com", "RegionId=cn-hangzhou&PageSize=10", "vpcList", "VPC 列表"),
  acs("aliyun-vpc-vswitch", "VPC", "查询交换机", "DescribeVSwitches", "2016-04-28", "vpc.aliyuncs.com", "RegionId=cn-hangzhou&PageSize=10", "subnetList", "VSwitch 列表"),
  acs("aliyun-vpc-eip", "VPC", "查询弹性公网 IP", "DescribeEipAddresses", "2016-04-28", "vpc.aliyuncs.com", "RegionId=cn-hangzhou&PageSize=10", "eipList", "EIP 列表"),
  acs("aliyun-rds-list", "RDS", "查询数据库实例", "DescribeDBInstances", "2014-08-15", "rds.aliyuncs.com", "RegionId=cn-hangzhou&PageSize=10", "rdsList", "RDS 实例"),
  acs("aliyun-slb-list", "SLB", "查询负载均衡", "DescribeLoadBalancers", "2014-05-15", "slb.aliyuncs.com", "RegionId=cn-hangzhou&PageSize=10", "loadBalancerList", "传统型负载均衡"),
  acs("aliyun-ram-users", "RAM", "查询用户", "ListUsers", "2015-05-01", "ram.aliyuncs.com", "MaxItems=20", "iamUserList", "RAM 用户"),
  acs("aliyun-ram-roles", "RAM", "查询角色", "ListRoles", "2015-05-01", "ram.aliyuncs.com", "MaxItems=20", "iamRoleList", "RAM 角色"),
  acs("aliyun-dns-domains", "DNS", "查询域名", "DescribeDomains", "2015-01-09", "alidns.aliyuncs.com", "PageSize=10", "domainList", "云解析域名"),
  acs("aliyun-sms-send", "短信", "发送短信", "SendSms", "2017-05-25", "dysmsapi.aliyuncs.com", "PhoneNumbers=13800138000&SignName=示例签名&TemplateCode=SMS_0000000&TemplateParam={\"code\":\"1234\"}", "smsSend", "会产生真实短信调用", { risk: "write" }),

  tc3("tencent-sts-identity", "STS", "校验身份", "sts", "GetCallerIdentity", "2018-08-13", "identity", "确认当前密钥对应的账号与 ARN", EMPTY_JSON),
  tc3("tencent-cvm-regions", "CVM", "查询地域", "cvm", "DescribeRegions", "2017-03-12", "regionList", "CVM 可用地域", EMPTY_JSON),
  tc3("tencent-cvm-list", "CVM", "查询实例", "cvm", "DescribeInstances", "2017-03-12", "instanceList", "业务参数使用 JSON Body"),
  tc3("tencent-cvm-sg", "CVM", "查询安全组", "cvm", "DescribeSecurityGroups", "2017-03-12", "securityGroupList", "当前地域安全组"),
  tc3("tencent-cbs-disks", "CBS", "查询云硬盘", "cbs", "DescribeDisks", "2017-03-12", "diskList", "云硬盘列表"),
  tc3("tencent-vpc-list", "VPC", "查询私有网络", "vpc", "DescribeVpcs", "2017-03-12", "vpcList", "VPC 列表"),
  tc3("tencent-vpc-subnet", "VPC", "查询子网", "vpc", "DescribeSubnets", "2017-03-12", "subnetList", "子网列表"),
  tc3("tencent-vpc-eip", "VPC", "查询弹性公网 IP", "vpc", "DescribeAddresses", "2017-03-12", "eipList", "EIP 列表"),
  tc3("tencent-cdb-list", "CDB", "查询数据库实例", "cdb", "DescribeDBInstances", "2017-03-20", "rdsList", "云数据库 MySQL"),
  tc3("tencent-clb-list", "CLB", "查询负载均衡", "clb", "DescribeLoadBalancers", "2018-03-17", "loadBalancerList", "负载均衡实例"),
  tc3("tencent-cam-users", "CAM", "查询用户", "cam", "ListUsers", "2019-01-16", "iamUserList", "CAM 子用户", EMPTY_JSON),
  tc3("tencent-cam-roles", "CAM", "查询角色", "cam", "ListRoles", "2019-01-16", "iamRoleList", "CAM 角色", EMPTY_JSON),
  tc3("tencent-dnspod-domains", "DNS", "查询域名", "dnspod", "DescribeDomainList", "2021-03-23", "domainList", "DNSPod 域名", "{\n  \"Type\": \"ALL\",\n  \"Limit\": 10,\n  \"Offset\": 0\n}"),
  tc3("tencent-sms-send", "短信", "发送短信", "sms", "SendSms", "2021-01-11", "smsSend", "会产生真实短信调用", "{\n  \"SmsSdkAppId\": \"1400000000\",\n  \"SignName\": \"示例签名\",\n  \"TemplateId\": \"000000\",\n  \"TemplateParamSet\": [\"1234\"],\n  \"PhoneNumberSet\": [\"+8613800138000\"]\n}", { risk: "write" }),

  huawei("huawei-iam-projects", "IAM", "查询项目", "https://iam.myhuaweicloud.com/v3/projects", "projectList", "列出账号项目，后续接口需要项目 ID", ""),
  huawei("huawei-ecs-list", "ECS", "查询实例", "https://ecs.cn-north-4.myhuaweicloud.com/v1/YOUR_PROJECT_ID/cloudservers/detail", "instanceList", "请替换 Endpoint 中的项目 ID"),
  huawei("huawei-vpc-list", "VPC", "查询 VPC", "https://vpc.cn-north-4.myhuaweicloud.com/v1/YOUR_PROJECT_ID/vpcs", "vpcList", "请替换 Endpoint 中的项目 ID"),
  huawei("huawei-vpc-subnet", "VPC", "查询子网", "https://vpc.cn-north-4.myhuaweicloud.com/v1/YOUR_PROJECT_ID/subnets", "subnetList", "请替换 Endpoint 中的项目 ID"),
  huawei("huawei-vpc-sg", "VPC", "查询安全组", "https://vpc.cn-north-4.myhuaweicloud.com/v1/YOUR_PROJECT_ID/security-groups", "securityGroupList", "请替换 Endpoint 中的项目 ID"),
  huawei("huawei-vpc-eip", "VPC", "查询弹性公网 IP", "https://vpc.cn-north-4.myhuaweicloud.com/v1/YOUR_PROJECT_ID/publicips", "eipList", "请替换 Endpoint 中的项目 ID"),
  huawei("huawei-rds-list", "RDS", "查询数据库实例", "https://rds.cn-north-4.myhuaweicloud.com/v3/YOUR_PROJECT_ID/instances", "rdsList", "请替换 Endpoint 中的项目 ID"),
  huawei("huawei-dns-zones", "DNS", "查询域名", "https://dns.myhuaweicloud.com/v2/zones", "domainList", "公网/内网 Zone 列表"),

  volc("volcengine-iam-users", "IAM", "查询用户", "iam", "ListUsers", "2018-01-01", "iamUserList", "Action/Version 自动加入 Query", "Limit=10&Offset=0"),
  volc("volcengine-iam-roles", "IAM", "查询角色", "iam", "ListRoles", "2018-01-01", "iamRoleList", "IAM 角色", "Limit=10&Offset=0"),
  volc("volcengine-ecs-regions", "ECS", "查询地域", "ecs", "DescribeRegions", "2020-04-01", "regionList", "ECS 可用地域", ""),
  volc("volcengine-ecs-list", "ECS", "查询实例", "ecs", "DescribeInstances", "2020-04-01", "instanceList", "云服务器实例", "MaxResults=10"),
  volc("volcengine-vpc-list", "VPC", "查询私有网络", "vpc", "DescribeVpcs", "2020-04-01", "vpcList", "VPC 列表"),
  volc("volcengine-vpc-subnet", "VPC", "查询子网", "vpc", "DescribeSubnets", "2020-04-01", "subnetList", "子网列表"),
  volc("volcengine-vpc-sg", "VPC", "查询安全组", "vpc", "DescribeSecurityGroups", "2020-04-01", "securityGroupList", "安全组列表"),
  volc("volcengine-vpc-eip", "VPC", "查询弹性公网 IP", "vpc", "DescribeEipAddresses", "2020-04-01", "eipList", "EIP 列表"),
  volc("volcengine-rds-list", "RDS", "查询数据库实例", "rds_mysql", "DescribeDBInstances", "2022-01-01", "rdsList", "云数据库 MySQL", "MaxResults=10", { endpoint: "https://rds.volcengineapi.com" }),

  bce("baidu-iam-users", "IAM", "查询用户", "https://iam.bj.baidubce.com/v1/user", "iamUserList", "IAM 用户", "maxKeys=10"),
  bce("baidu-bcc-instances", "BCC", "查询实例", "https://bcc.bj.baidubce.com/v2/instance", "instanceList", "北京区域只读实例查询"),
  bce("baidu-bcc-sg", "BCC", "查询安全组", "https://bcc.bj.baidubce.com/v2/securityGroup", "securityGroupList", "安全组列表"),
  bce("baidu-bcc-disks", "BCC", "查询云磁盘", "https://bcc.bj.baidubce.com/v2/volume", "diskList", "CDS 云磁盘"),
  bce("baidu-vpc-list", "VPC", "查询私有网络", "https://bcc.bj.baidubce.com/v1/vpc", "vpcList", "VPC 列表", "maxKeys=10"),
  bce("baidu-vpc-subnet", "VPC", "查询子网", "https://bcc.bj.baidubce.com/v1/subnet", "subnetList", "子网列表", "maxKeys=10"),
  bce("baidu-vpc-eip", "EIP", "查询弹性公网 IP", "https://eip.bj.baidubce.com/v1/eip", "eipList", "EIP 列表", "maxKeys=10"),
  bce("baidu-rds-list", "RDS", "查询数据库实例", "https://rds.bj.baidubce.com/v1/instance", "rdsList", "RDS 实例", "maxKeys=10"),
  bce("baidu-blb-list", "BLB", "查询负载均衡", "https://blb.bj.baidubce.com/v1/blb", "loadBalancerList", "负载均衡实例", "maxKeys=10"),

  ezviz("ezviz-token-get", "账号", "获取 Token", "/api/lapp/token/get", "identity", "用 AppKey/AppSecret 换 AccessToken，有效期约 7 天", ""),
  ezviz("ezviz-device-list", "设备", "查询设备", "/api/lapp/device/list", "deviceList", "当前账号下的设备列表"),
  ezviz("ezviz-camera-list", "设备", "查询摄像头", "/api/lapp/camera/list", "cameraList", "监控点 / 通道列表"),
  ezviz("ezviz-device-info", "设备", "查询设备信息", "/api/lapp/device/info", "deviceList", "按序列号查单台设备", "deviceSerial="),
  ezviz("ezviz-device-status-get", "设备", "查询设备状态", "/api/lapp/device/status/get", "deviceList", "按序列号和通道查在线状态", "deviceSerial=&channel=1"),
  ezviz("ezviz-device-camera-list", "设备", "查询设备通道", "/api/lapp/device/camera/list", "cameraList", "指定设备的通道列表", "deviceSerial="),
  ezviz("ezviz-device-capacity", "设备", "查询设备能力", "/api/lapp/device/capacity", "deviceList", "设备能力集", "deviceSerial="),
  ezviz("ezviz-live-video-list", "直播", "查询直播列表", "/api/lapp/live/video/list", "liveList", "账号下已开通的直播源"),
  ezviz("ezviz-live-address-get", "直播", "获取直播地址", "/api/lapp/v2/live/address/get", "liveList", "按设备序列号取播放地址，需填 deviceSerial", "deviceSerial=&channelNo=1&protocol=2"),

  tdt("tianditu-geocode", "地理", "地址转坐标", "/geocoder", 'ds={"keyWord":"北京市海淀区莲花池西路28号"}', "geoResult", "地理编码，tk 由本机自动追加"),
  tdt("tianditu-regeocode", "地理", "坐标转地址", "/geocoder", 'postStr={"lon":116.37304,"lat":39.92594,"ver":1}&type=geocode', "geoResult", "逆地理编码"),
  tdt("tianditu-search", "检索", "关键词搜索", "/v2/search", 'postStr={"keyWord":"天安门","queryType":1,"start":0,"count":10,"level":12,"mapBound":"116.0,39.7,116.8,40.1"}&type=query', "poiList", "行政区 / POI 检索"),
  tdt("tianditu-drive", "路径", "驾车规划", "/drive", 'postStr={"orig":"116.35506,39.92277","dest":"116.39747,39.90882"}&type=search', "geoResult", "驾车路线，返回可能是 XML/JSON"),

  qiniu("qiniu-buckets", "空间", "列举空间", "https://uc.qiniuapi.com/buckets", "", "bucketNameList", "当前密钥下的 Bucket 列表"),
  qiniu("qiniu-bucket-info", "空间", "查询空间信息", "https://uc.qiniuapi.com/v2/bucketInfo", "bucket=", "bucketInfo", "机房、私有属性和源站域名，先填 bucket"),
  qiniu("qiniu-bucket-quota", "空间", "查询空间配额", "https://uc.qiniuapi.com/v2/bucketQuota", "bucket=", "bucketInfo", "容量和文件数配额，-1 表示不限制"),
  qiniu("qiniu-query-region", "空间", "查询上传区域", "https://uc.qiniuapi.com/v4/query", "bucket=", "uploadRegion", "按 bucket 查上传/源站域名，ak 由本机追加", "queryRegion"),
  qiniu("qiniu-list", "空间", "列举文件", "https://rsf.qiniuapi.com/list", "bucket=&limit=10", "objectList", "指定空间的对象列表，先填 bucket"),
  qiniu("qiniu-stat", "空间", "查询文件信息", "https://rs.qiniu.com/stat", "bucket=&key=", "objectList", "按 bucket + key 查元数据", "stat"),
  qiniu("qiniu-domains", "空间", "查询绑定域名", "https://api.qiniu.com/v6/domain/list", "tbl=", "bucketNameList", "空间绑定的访问域名，tbl 填 Bucket 名"),
];

export function groupPresetsByProvider(presets: CloudPreset[]) {
  return PROVIDER_ORDER.map((provider) => {
    const items = presets.filter((item) => item.provider === provider);
    const productOrder: string[] = [];
    for (const item of items) {
      if (!productOrder.includes(item.product)) productOrder.push(item.product);
    }
    return {
      provider,
      meta: PROVIDERS[provider],
      presets: items,
      products: productOrder.map((product) => ({
        product,
        presets: items.filter((item) => item.product === product),
      })),
    };
  }).filter((group) => group.presets.length > 0);
}

export function findPreset(id: string) {
  return PRESETS.find((item) => item.id === id) ?? PRESETS[0];
}

export function applyRegionToPreset(preset: CloudPreset, region: string): CloudPreset {
  if (!region) return preset;
  return {
    ...preset,
    region,
    query: /(?:^|&)RegionId=/.test(preset.query) ? replaceQueryValue(preset.query, "RegionId", region) : preset.query,
  };
}

export function enumerationPresets(provider: CloudProvider) {
  const rank = (item: CloudPreset) => {
    if (item.resultKind === "identity" || item.resultKind === "bucketNameList") return 0;
    if (item.resultKind === "projectList") return 1;
    if (item.resultKind === "regionList") return 2;
    return 3;
  };
  return PRESETS
    .filter((item) => item.provider === provider && item.risk !== "write")
    .sort((a, b) => rank(a) - rank(b) || a.product.localeCompare(b.product, "zh"));
}

export function needsProjectPlaceholder(preset: CloudPreset) {
  return preset.endpoint.includes("YOUR_PROJECT_ID");
}

export const REGION_OPTIONS: Partial<Record<CloudProvider, string[]>> = {
  alibabaAcs3: ["cn-hangzhou", "cn-shanghai", "cn-beijing", "cn-shenzhen", "cn-chengdu", "cn-hongkong"],
  tencentTc3: ["ap-guangzhou", "ap-shanghai", "ap-beijing", "ap-chengdu", "ap-nanjing", "ap-hongkong"],
  volcengineHmac: ["cn-beijing", "cn-shanghai", "cn-guangzhou", "cn-hongkong"],
};

export function replaceQueryValue(query: string, key: string, value: string) {
  const pattern = new RegExp(`(^|&)${key}=[^&]*`);
  if (pattern.test(query)) return query.replace(pattern, `$1${key}=${value}`);
  return query ? `${query}&${key}=${value}` : `${key}=${value}`;
}

export function presetMatchesQuery(preset: CloudPreset, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [preset.label, preset.product, preset.action, preset.description, preset.endpoint, preset.service]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}
