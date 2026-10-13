/**
 * Made-up records for the /dev/ui showcase (not real customers). Names, areas and numbers are
 * data, not interface words, so they are not i18n keys.
 */
export type SampleCustomer = {
  id: string;
  code: string;
  name: string;
  phone: string;
  vc: string;
  area: string;
  active: boolean;
  /** Positive = due, negative = credit (integer paise). */
  balancePaise: number;
};

export const SAMPLE_CUSTOMERS: readonly SampleCustomer[] = [
  {
    id: "c1",
    code: "C-101",
    name: "Ramesh Kumar",
    phone: "98765 43210",
    vc: "12345",
    area: "Ward 4",
    active: true,
    balancePaise: 45_000,
  },
  {
    id: "c2",
    code: "C-102",
    name: "Sita Devi",
    phone: "98111 22233",
    vc: "23456",
    area: "Ward 4",
    active: true,
    balancePaise: 0,
  },
  {
    id: "c3",
    code: "C-103",
    name: "Mohammed Irfan",
    phone: "99000 11122",
    vc: "34567",
    area: "Station Road",
    active: false,
    balancePaise: 12_345_600,
  },
  {
    id: "c4",
    code: "C-104",
    name: "Lakshmi Narayanan",
    phone: "97300 44556",
    vc: "45678",
    area: "Ward 7",
    active: true,
    balancePaise: -5_000,
  },
  {
    id: "c5",
    code: "C-105",
    name: "Ramesh Singh",
    phone: "91234 56789",
    vc: "56789",
    area: "Ward 7",
    active: true,
    balancePaise: 30_000,
  },
];

/** Fake async search: matches name, code, phone or VC number after a short delay. */
export function searchSampleCustomers(
  query: string,
  signal: AbortSignal,
): Promise<readonly SampleCustomer[]> {
  const needle = query.toLowerCase().replaceAll(" ", "");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(
        SAMPLE_CUSTOMERS.filter((customer) =>
          [customer.name, customer.code, customer.phone, customer.vc].some((field) =>
            field.toLowerCase().replaceAll(" ", "").includes(needle),
          ),
        ),
      );
    }, 300);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}
