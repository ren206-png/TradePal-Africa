import { describe, expect, it } from "vitest";
import { getCountryByCode, getCountryByPhoneNumber, SUPPORTED_COUNTRIES } from "../src/config/countries.js";

describe("country config", () => {
  it("lists exactly the four target markets", () => {
    expect(SUPPORTED_COUNTRIES.map((c) => c.code).sort()).toEqual(["GH", "KE", "NG", "SL"]);
  });

  it("resolves a country by ISO code", () => {
    expect(getCountryByCode("KE")?.name).toBe("Kenya");
    expect(getCountryByCode("XX")).toBeUndefined();
  });

  it("resolves a country from a WhatsApp phone number's calling code", () => {
    expect(getCountryByPhoneNumber("2348012345678")?.code).toBe("NG");
    expect(getCountryByPhoneNumber("+254712345678")?.code).toBe("KE");
    expect(getCountryByPhoneNumber("23276123456")?.code).toBe("SL");
    expect(getCountryByPhoneNumber("233241234567")?.code).toBe("GH");
    expect(getCountryByPhoneNumber("15550001111")).toBeUndefined();
  });

  it("gates voice off for Sierra Leone only, per the Krio ASR finding", () => {
    expect(getCountryByCode("SL")?.voiceEnabled).toBe(false);
    expect(getCountryByCode("NG")?.voiceEnabled).toBe(true);
    expect(getCountryByCode("KE")?.voiceEnabled).toBe(true);
    expect(getCountryByCode("GH")?.voiceEnabled).toBe(true);
  });
});
