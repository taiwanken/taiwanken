import('node-fetch').then(({ default: fetch }) => {
    async function findCreatorId(url, authorityId) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error('Failed to fetch data');
            }
            const jsonData = await response.json();
            rootJson = jsonData;  // Store the fetched JSON in a global variable for access in other functions
            return traverseJson(jsonData, authorityId);
        } catch (error) {
            console.error('Error fetching or processing data:', error.message);
            return null;
        }
    }

    function traverseJson(data, authorityId, path = []) {
        if (data && typeof data === 'object') {
            if (Array.isArray(data)) {
                for (let i = 0; i < data.length; i++) {
                    const result = traverseJson(data[i], authorityId, path.concat(i));
                    if (result) return result;
                }
            } else {
                for (const key in data) {
                    if (typeof data[key] === 'string' && data[key] === authorityId) {
                        return backtrackForCarriedOutBy(path);
                    } else if (typeof data[key] === 'object') {
                        const result = traverseJson(data[key], authorityId, path.concat(key));
                        if (result) return result;
                    }
                }
            }
        }
        return null;
    }

    function backtrackForCarriedOutBy(path) {
        let currentNode = rootJson;
        for (let key of path) {
            currentNode = currentNode[key];
        }
        while (path.length > 0) {
            if (currentNode.carried_out_by) {
                return currentNode.carried_out_by;
            }
            path.pop();
            currentNode = rootJson;
            for (let key of path) {
                currentNode = currentNode[key];
            }
        }
        return null;
    }

    const url = 'https://data.getty.edu/museum/collection/object/951295b7-dfb2-42fa-b06e-5a1c350dd88d';  // Example URL
    const authorityId = 'http://vocab.getty.edu/aat/300025103';  // Example authority ID

    findCreatorId(url, authorityId)
        .then(creatorId => {
            if (creatorId) {
                console.log('Creator ID:', creatorId);
            } else {
                console.log('No creator ID found for the specified authority ID.');
            }
        })
        .catch(error => {
            console.error('Error:', error.message);
        });
}).catch(error => {
    console.error('Error loading node-fetch:', error);
});
