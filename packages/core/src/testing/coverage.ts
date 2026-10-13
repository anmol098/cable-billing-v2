/**
 * Isolation coverage rules (T-025 acceptance: "Coverage test fails when a new service is added
 * without isolation cases"). Pure: takes what `discovery.ts` found and lists the problems.
 */
import { z } from "zod";
import type { AnyService } from "../context/service";
import type { DiscoveredCaseSet, DiscoveredService } from "./discovery";

/** Minimum length of an exemption reason (it must explain something). */
export const MIN_EXEMPTION_REASON = 30;

/** True when the service's input schema contains a UUID anywhere (an id the caller chooses). */
export function inputTakesIds(service: AnyService): boolean {
  try {
    const schema = z.toJSONSchema(service.input, { unrepresentable: "any", io: "input" });
    return JSON.stringify(schema).includes('"format":"uuid"');
  } catch {
    return true; // can't tell: be strict
  }
}

/**
 * The coverage problems, one sentence each (empty = every service is covered):
 * - a service with no case set;
 * - two different services with the same name;
 * - a case set for a service that is not exported from any core module;
 * - a case set with no cases, or (when the input takes ids) no `not_found` case;
 * - an exemption without a real reason.
 */
export function findCoverageGaps(
  services: readonly DiscoveredService[],
  sets: readonly DiscoveredCaseSet[],
): string[] {
  const gaps: string[] = [];
  const byName = new Map<string, DiscoveredService>();
  for (const found of services) {
    const other = byName.get(found.service.name);
    if (other && other.service !== found.service) {
      gaps.push(
        `Two services are named "${found.service.name}" (${other.file}#${other.exportName} and ${found.file}#${found.exportName}); names must be unique.`,
      );
    } else {
      byName.set(found.service.name, found);
    }
  }

  const known = new Set(services.map((s) => s.service));
  const covered = new Set<AnyService>();
  for (const { set, file, exportName } of sets) {
    const where = `${file}#${exportName}`;
    if (!known.has(set.service)) {
      gaps.push(
        `${where} registers cases for "${set.service.name}", which no core module exports (export the service).`,
      );
      continue;
    }
    covered.add(set.service);
    if (set.exempt !== undefined) {
      if (set.exempt.trim().length < MIN_EXEMPTION_REASON) {
        gaps.push(`${where} exempts "${set.service.name}" without a real reason.`);
      }
      continue;
    }
    if (set.cases.length === 0) {
      gaps.push(`${where} has no cases for "${set.service.name}".`);
      continue;
    }
    const hasNotFound = set.cases.some((c) => (c.expect ?? "not_found") === "not_found");
    if (inputTakesIds(set.service) && !hasNotFound) {
      gaps.push(
        `${where}: "${set.service.name}" takes ids but has no "not_found" case (call it with the other tenant's ids).`,
      );
    }
  }

  for (const { service, file, exportName } of services) {
    if (!covered.has(service)) {
      const isolationFile = file.replace(/\.ts$/, ".isolation.ts");
      gaps.push(
        `Service "${service.name}" (${file}#${exportName}) has no tenant isolation cases: add defineIsolationCases(${exportName}, …) to ${isolationFile} (see @cb/core/testing).`,
      );
    }
  }
  return gaps;
}
