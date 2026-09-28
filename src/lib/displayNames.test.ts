import { describe, expect, it } from 'vitest';
import { byPersonName, departmentDisplayName, employeeNumber, personCode, personDisplayName, personInitials, shortPersonName } from './displayNames';

/**
 * Names as the org's records actually carry them (examples taken from the ENEC CAFM employee and
 * department lists): an employee number or cost-centre code in front, doubled spaces, stray tabs.
 */

describe('employee names', () => {
  it('drops the employee number in front of the name', () => {
    expect(personDisplayName('251850 - Johar Ali Ali Asghar')).toBe('Johar Ali Ali Asghar');
    expect(personDisplayName('22250606 - Cristine Fordan Beltran')).toBe('Cristine Fordan Beltran');
    expect(personDisplayName('00250001 - MFM Test  Employee Two')).toBe('MFM Test Employee Two');
  });

  it('keeps the number, separately', () => {
    expect(personCode('251850 - Johar Ali Ali Asghar')).toBe('251850');
    expect(personCode('00250001 - MFM Test  Employee Two')).toBe('00250001');
    expect(personCode('Sajjad Ali Abdulrehman')).toBeNull();
  });

  it('prefers the HRMS id when the org fills it', () => {
    expect(employeeNumber({ name: '251850 - Johar Ali Ali Asghar', hrmsEmployeeId: 'E-251850' })).toBe('E-251850');
    expect(employeeNumber({ name: '251850 - Johar Ali Ali Asghar', hrmsEmployeeId: '' })).toBe('251850');
    expect(employeeNumber({ name: 'Sajjad Ali Abdulrehman' })).toBeNull();
  });

  it('tidies doubled spaces, tabs and a blank surname', () => {
    expect(personDisplayName('250155 - Babu  Thomas')).toBe('Babu Thomas');
    expect(personDisplayName('22250608 - Monette Cabase Briones\t')).toBe('Monette Cabase Briones');
    expect(personDisplayName('22250612 - Benesa Notar\t Hernandez')).toBe('Benesa Notar Hernandez');
    expect(personDisplayName('20060026 - Pappu  -')).toBe('Pappu');
  });

  it('leaves a name without a number alone', () => {
    expect(personDisplayName('Sajjad Ali Abdulrehman')).toBe('Sajjad Ali Abdulrehman');
    expect(personDisplayName('Robin MFM')).toBe('Robin MFM');
  });

  it('takes initials from the name, never from the number', () => {
    expect(personInitials('251850 - Johar Ali Ali Asghar')).toBe('JA');
    expect(personInitials('20060026 - Pappu  -')).toBe('P');
    expect(personInitials('Amrithya')).toBe('A');
  });
});

describe('short names for labels', () => {
  it('keeps a name that fits', () => {
    expect(shortPersonName('Babu Thomas', 20)).toBe('Babu Thomas');
  });

  it('shortens to first name + surname', () => {
    expect(shortPersonName('Abdulrahman Abdullah Khalaf AlAnazi', 20)).toBe('Abdulrahman AlAnazi');
    expect(shortPersonName('Mohammad Mokhatar Mohammad Ilayas', 20)).toBe('Mohammad Ilayas');
  });

  it('keeps a particle with the surname', () => {
    expect(shortPersonName('Mohamed Abdullah Ahmed Al Marzooqi', 20)).toBe('Mohamed Al Marzooqi');
    expect(shortPersonName('Claire Cristobal De Juan', 15)).toBe('Claire De Juan');
  });

  it('never leaves a surname that is only an initial', () => {
    expect(shortPersonName('Abdilla Al-Sharif S', 12)).toBe('Abdilla Al-Sharif S');
    expect(shortPersonName('Lorien Noreen M', 10)).toBe('Lorien Noreen M');
  });
});

describe('department names', () => {
  it('drops the cost-centre code', () => {
    expect(departmentDisplayName('10000264-Investment Executive Program')).toBe('Investment Executive Program');
    expect(departmentDisplayName('10000204-Chief Communications & PR Officer Office')).toBe('Chief Communications & PR Officer Office');
  });

  it('leaves a plain department alone', () => {
    expect(departmentDisplayName('Information Technology')).toBe('Information Technology');
    expect(departmentDisplayName('It support (Digital Strategy)')).toBe('It support (Digital Strategy)');
  });
});

describe('ordering', () => {
  it('orders people by the name shown, not the employee number in front of it', () => {
    const people = [{ name: '251850 - Johar Ali' }, { name: '22250607 - Claire Cristobal' }, { name: '251795 - Abdulrahman Abdullah' }];
    expect([...people].sort(byPersonName).map((p) => personDisplayName(p.name))).toEqual(['Abdulrahman Abdullah', 'Claire Cristobal', 'Johar Ali']);
  });
});
