(function () {
  "use strict";

  function isoDate(date) { return date.toISOString().slice(0, 10); }
  function moveDate(date, days) {
    const moved = new Date(date.getTime());
    moved.setUTCDate(moved.getUTCDate() + days);
    return moved;
  }
  function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day));
  }
  function holiday(date, name, scope) { return { date: date, name: name, scope: scope }; }
  function forYear(year) {
    const y = Number(year);
    const fixedNational = [
      ["01-01", "Confraternização Universal"],
      ["04-21", "Tiradentes"],
      ["05-01", "Dia do Trabalho"],
      ["09-07", "Independência do Brasil"],
      ["10-12", "Nossa Senhora Aparecida"],
      ["11-02", "Finados"],
      ["11-15", "Proclamação da República"],
      ["11-20", "Dia Nacional de Zumbi e da Consciência Negra"],
      ["12-25", "Natal"]
    ];
    const holidays = fixedNational.map(function (entry) {
      return holiday(y + "-" + entry[0], entry[1], "Nacional");
    });
    const easter = easterSunday(y);

    // Lei Estadual ES nº 11.010/2019: segunda-feira, oitavo dia após a Páscoa.
    holidays.push(holiday(isoDate(moveDate(easter, 8)), "Nossa Senhora da Penha", "Estadual · Espírito Santo"));

    // Lei Municipal de Anchieta nº 986/2014, art. 1º.
    holidays.push(holiday(isoDate(moveDate(easter, -2)), "Sexta-feira da Paixão", "Municipal · Anchieta"));
    holidays.push(holiday(y + "-06-09", "São José de Anchieta", "Municipal · Anchieta"));
    holidays.push(holiday(y + "-06-29", "São Pedro", "Municipal · Anchieta"));
    holidays.push(holiday(y + "-08-15", "Nossa Senhora da Assunção", "Municipal · Anchieta"));

    return holidays.sort(function (a, b) {
      return a.date.localeCompare(b.date) || a.name.localeCompare(b.name, "pt-BR");
    });
  }

  window.RENTAL_HOLIDAYS = { forYear: forYear };
})();
