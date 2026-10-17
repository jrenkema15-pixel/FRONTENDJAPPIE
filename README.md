# Madridistas Pubquiz

Een pubquiz voor op een groot scherm. Iedereen speelt mee op zijn eigen telefoon, zonder account.

- `index.html`: de pagina. Open je hem zonder code, dan kun je meedoen door een code te typen.
- Het grote scherm opent met de organisatorlink. Alleen die link heeft de sleutel waarmee de vragen in `rounds.enc.js` leesbaar worden.
- Het grote scherm is de quizmaster: daar draaien de regels (`logic.js`). Telefoons en scherm praten met elkaar via openbare MQTT-relays. Alle berichten zijn versleuteld.
