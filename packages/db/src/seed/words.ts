/**
 * Built-in word lists for synthetic data (T-036). Names are common Indian given names and surnames
 * combined at random, in English and Devanagari script: they describe nobody. Nothing here comes
 * from the legacy database or any other real record.
 *
 * Phone numbers are not words but follow the same idea: every seeded number is in the clearly fake
 * range `555xxxxxxx` (no Indian mobile number starts with 5), see `fakePhone` in generate.ts.
 */

/** A word in English and in Devanagari. */
export type Bilingual = readonly [en: string, hi: string];

export const MALE_NAMES: readonly Bilingual[] = [
  ["Ramesh", "रमेश"],
  ["Suresh", "सुरेश"],
  ["Mahesh", "महेश"],
  ["Rajesh", "राजेश"],
  ["Dinesh", "दिनेश"],
  ["Mukesh", "मुकेश"],
  ["Rakesh", "राकेश"],
  ["Anil", "अनिल"],
  ["Sunil", "सुनील"],
  ["Vijay", "विजय"],
  ["Ajay", "अजय"],
  ["Sanjay", "संजय"],
  ["Manoj", "मनोज"],
  ["Pramod", "प्रमोद"],
  ["Vinod", "विनोद"],
  ["Ashok", "अशोक"],
  ["Arun", "अरुण"],
  ["Deepak", "दीपक"],
  ["Gopal", "गोपाल"],
  ["Mohan", "मोहन"],
  ["Sohan", "सोहन"],
  ["Ravi", "रवि"],
  ["Amit", "अमित"],
  ["Rohit", "रोहित"],
  ["Sachin", "सचिन"],
  ["Pankaj", "पंकज"],
  ["Naresh", "नरेश"],
  ["Kamal", "कमल"],
  ["Hari", "हरि"],
  ["Shyam", "श्याम"],
  ["Govind", "गोविंद"],
  ["Bhola", "भोला"],
  ["Raju", "राजू"],
  ["Pappu", "पप्पू"],
  ["Imran", "इमरान"],
  ["Salim", "सलीम"],
  ["Harpreet", "हरप्रीत"],
  ["Gurdeep", "गुरदीप"],
];

export const FEMALE_NAMES: readonly Bilingual[] = [
  ["Sunita", "सुनीता"],
  ["Anita", "अनीता"],
  ["Geeta", "गीता"],
  ["Seema", "सीमा"],
  ["Rekha", "रेखा"],
  ["Meena", "मीना"],
  ["Kamla", "कमला"],
  ["Savitri", "सावित्री"],
  ["Pushpa", "पुष्पा"],
  ["Usha", "उषा"],
  ["Asha", "आशा"],
  ["Lata", "लता"],
  ["Pooja", "पूजा"],
  ["Priya", "प्रिया"],
  ["Neha", "नेहा"],
  ["Kavita", "कविता"],
  ["Suman", "सुमन"],
  ["Radha", "राधा"],
  ["Sarita", "सरिता"],
  ["Shabnam", "शबनम"],
  ["Rubina", "रुबीना"],
  ["Manjeet", "मनजीत"],
];

export const SURNAMES: readonly Bilingual[] = [
  ["Kumar", "कुमार"],
  ["Sharma", "शर्मा"],
  ["Verma", "वर्मा"],
  ["Gupta", "गुप्ता"],
  ["Singh", "सिंह"],
  ["Yadav", "यादव"],
  ["Mishra", "मिश्रा"],
  ["Tiwari", "तिवारी"],
  ["Pandey", "पांडे"],
  ["Chauhan", "चौहान"],
  ["Prajapati", "प्रजापति"],
  ["Jaiswal", "जायसवाल"],
  ["Agarwal", "अग्रवाल"],
  ["Saini", "सैनी"],
  ["Rathore", "राठौर"],
  ["Meena", "मीणा"],
  ["Patel", "पटेल"],
  ["Thakur", "ठाकुर"],
  ["Devi", "देवी"],
  ["Khan", "ख़ान"],
  ["Ansari", "अंसारी"],
  ["Qureshi", "क़ुरैशी"],
  ["Gill", "गिल"],
  ["Sandhu", "संधू"],
];

/**
 * Operator (business) names. The first one is used for **two** operators on purpose: names are not
 * unique (FR-002), and the UI and the admin console must tell such tenants apart.
 */
export const OPERATOR_NAMES: readonly string[] = [
  "Shiv Cable Network",
  "Shree Ganesh Cable TV",
  "Jai Mata Di Cable",
  "Sai Digital Cable",
  "Balaji Cable Network",
  "New Star Cable",
  "Krishna Cable Vision",
  "Royal Cable Network",
  "Durga Digital TV",
  "City Cable Service",
  "Hanuman Cable Network",
  "Shubh Cable TV",
];

/** Locality names (generic, found in many towns). The Devanagari ones test Hindi area names. */
export const AREA_NAMES: readonly string[] = [
  "Gandhi Nagar",
  "Nehru Colony",
  "Station Road",
  "Ram Nagar",
  "Shastri Nagar",
  "Subhash Chowk",
  "Purana Bazaar",
  "Civil Lines",
  "Indira Colony",
  "Ambedkar Nagar",
  "Patel Nagar",
  "Tilak Nagar",
  "Mill Area",
  "Railway Colony",
  "Ward 3",
  "Ward 7",
  "Ward 12",
  "शिवाजी नगर",
  "गांधी चौक",
  "पुरानी बस्ती",
  "नई बस्ती",
  "मंडी रोड",
];

/** Plan names with their monthly rental in whole rupees (multiples of ₹10). */
export const PLAN_CATALOGUE: readonly (readonly [name: string, rupees: number])[] = [
  ["Basic", 200],
  ["Basic Plus", 250],
  ["Silver", 300],
  ["Family Pack", 350],
  ["Gold", 400],
  ["Sports", 450],
  ["HD Premium", 550],
  ["सस्ता पैक", 180],
];

/** Retired plan (kept on old connections, hidden from pickers). */
export const RETIRED_PLAN: readonly [name: string, rupees: number] = ["Old Basic", 150];

/** A ₹0 plan (free connections exist, FR-007 / T-040). */
export const FREE_PLAN: readonly [name: string, rupees: number] = ["Free", 0];

export const MANUAL_DEBIT_REASONS: readonly string[] = [
  "Repair visit",
  "Set-top box replacement",
  "New cable wire",
  "Reconnection charge",
];

export const MANUAL_CREDIT_REASONS: readonly string[] = [
  "Service outage discount",
  "Goodwill discount",
  "Festival offer",
  "Wrong bill corrected",
];

export const REVERSAL_REASONS: readonly string[] = [
  "Entered twice",
  "Wrong customer selected",
  "Wrong amount typed",
];

export const DISCONNECT_REASONS: readonly string[] = [
  "Moved away",
  "Switched to DTH",
  "Not paying",
  "Customer request",
];

export const PHONE_MODELS: readonly string[] = [
  "Redmi 12",
  "Galaxy A14",
  "Galaxy M13",
  "Realme C55",
  "Vivo Y16",
  "Moto G32",
  "Nokia G21",
];
