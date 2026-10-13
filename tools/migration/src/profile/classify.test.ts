import { describe, expect, it } from "vitest";
import { classifyColumn, columnWords } from "./classify";

const col = (name: string, columnType = "varchar(50)") => ({
  name,
  columnType,
  dataType: columnType.replace(/\(.*$/, ""),
});

describe("columnWords", () => {
  it("splits snake, camel and digits", () => {
    expect(columnWords("isReceipt")).toEqual(["is", "receipt"]);
    expect(columnWords("cust_mobile2")).toEqual(["cust", "mobile", "2"]);
    expect(columnWords("VCNumber")).toEqual(["vc", "number"]);
    expect(columnWords("op_id")).toEqual(["op", "id"]);
  });
});

describe("classifyColumn", () => {
  it.each([
    "name",
    "customerName",
    "cname",
    "owner_name",
    "mobile",
    "mobileNo",
    "alt_mobile",
    "phone",
    "address",
    "addr1",
    "email",
    "password",
    "passwd",
    "pwd",
    "token",
    "login",
    "username",
    "aadhaar_no",
  ])("%s is sensitive and identifying", (name) => {
    expect(classifyColumn(col(name))).toMatchObject({ class: "sensitive", identifying: true });
  });

  it("free text is sensitive but not identifying", () => {
    expect(classifyColumn(col("remark"))).toEqual({
      class: "sensitive",
      identifying: false,
      personName: false,
    });
  });

  it("marks person-name columns", () => {
    expect(classifyColumn(col("father_name")).personName).toBe(true);
    expect(classifyColumn(col("mobile")).personName).toBe(false);
  });

  it.each([
    ["status", "varchar(10)"],
    ["isReceipt", "tinyint(4)"],
    ["isDeleted", "int(11)"],
    ["pay_mode", "varchar(10)"],
    ["kind", "enum('a','b')"],
    ["flagged", "tinyint(1)"],
  ])("%s is a status column", (name, type) => {
    expect(classifyColumn(col(name, type)).class).toBe("enum");
  });

  it("sensitive wins over status", () => {
    expect(classifyColumn(col("contact_status")).class).toBe("sensitive");
    expect(classifyColumn(col("user_type")).class).toBe("sensitive");
  });

  it("finds money columns and leaves the rest alone", () => {
    expect(classifyColumn(col("amount", "int(11)")).class).toBe("money");
    expect(classifyColumn(col("balance", "float")).class).toBe("money");
    expect(classifyColumn(col("issue_date", "date")).class).toBe("other");
    expect(classifyColumn(col("vc_no")).class).toBe("other");
  });
});
