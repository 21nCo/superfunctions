// The UTC days that ended with a positive leap second (23:59:60), as announced
// in IERS Bulletin C and listed in IANA's leap-seconds.list (tzdb 2026f: file
// updated 2026-07-06, expires 2027-06-28). No negative leap second has ever
// occurred. The list is complete up to its expiry date; a leap second the IERS
// announces later needs a new release of this package.
//
// test/leap-seconds.test.ts compares this table and the package's results
// with the pinned IANA file in test/reference.

/** Days ending with 23:59:60 UTC, oldest first. */
export const LEAP_SECOND_DAYS = [
  "1972-06-30",
  "1972-12-31",
  "1973-12-31",
  "1974-12-31",
  "1975-12-31",
  "1976-12-31",
  "1977-12-31",
  "1978-12-31",
  "1979-12-31",
  "1981-06-30",
  "1982-06-30",
  "1983-06-30",
  "1985-06-30",
  "1987-12-31",
  "1989-12-31",
  "1990-12-31",
  "1992-06-30",
  "1993-06-30",
  "1994-06-30",
  "1995-12-31",
  "1997-06-30",
  "1998-12-31",
  "2005-12-31",
  "2008-12-31",
  "2012-06-30",
  "2015-06-30",
  "2016-12-31",
] as const;

/** The leap-second list is known to be complete before this UTC date. */
export const LEAP_SECOND_LIST_EXPIRES = "2027-06-28";
