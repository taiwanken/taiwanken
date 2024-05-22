const fs = require('fs');

function getCreatorId(data) {
  // Function to recursively search for 'carried_out_by' within 'produced_by'
  function findCarriedOutBy(obj) {
    let creatorIds = [];

    function recursiveSearch(obj) {
      if (obj && typeof obj === 'object') {
        if (Array.isArray(obj)) {
          for (let item of obj) {
            recursiveSearch(item);
          }
        } else {
          if (obj.hasOwnProperty('carried_out_by')) {
            creatorIds.push(obj.carried_out_by[0].id);
          }
          for (let key in obj) {
            if (obj.hasOwnProperty(key)) {
              recursiveSearch(obj[key]);
            }
          }
        }
      }
    }

    recursiveSearch(obj);

    if (creatorIds.length > 1) {
      return "Ambiguous creator data found.";
    } else if (creatorIds.length === 1) {
      return creatorIds[0];
    } else {
      return null;
    }
  }

  if (data && data.produced_by) {
    return findCarriedOutBy(data.produced_by);
  }

  return null;
}

// Example usage with the provided JSON files
const articData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\ARTIC example.json', 'utf8'));
const gettyData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\GETTY example.json', 'utf8'));
const luxData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\LUX example.json', 'utf8'));
const okeeffeData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\O KEEFFE example.json', 'utf8'));
const viennaData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\VIENNA example.json', 'utf8'));
const ambiguousData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\AMBIGUOUS example.json', 'utf8'));

console.log('ARTIC:', getCreatorId(articData)); // Output: https://api.artic.edu/api/v1/agents/20772
console.log('GETTY:', getCreatorId(gettyData)); // Output: (Assuming example similar to provided output)
console.log('LUX:', getCreatorId(luxData)); // Output: https://lux.collections.yale.edu/data/person/cdad5ce1-837b-425e-9893-6f76c5ed38d9
console.log('O KEEFFE:', getCreatorId(okeeffeData)); // Output: http://data.okeeffemuseum.org/person/2
console.log('VIENNA:', getCreatorId(viennaData)); // Output: https://data.exhibitions.univie.ac.at/Person/411
console.log('AMBIGUOUS:', getCreatorId(ambiguousData)); // Output: should be ambiguous
