The country signing CAs (CSCA) that passport and ID card chips are checked against (`../chip.js`).

- `masterlist.ml`: the German BSI's master list of 1 October 2026, from
  https://www.bsi.bund.de/SharedDocs/Downloads/DE/BSI/ElekAusweise/CSCA/GermanMasterList.html (a signed list of the CSCAs of
  about 110 countries, the Netherlands among them). The BSI publishes a new one every few months: replace this file with it.
- Any `.pem` file here is added too, for a country's new CSCA before the next master list has it.
