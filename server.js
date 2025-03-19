require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const axios = require('axios');

// Конфигурация
const MONGODB_URI = process.env.MONGO_URI;
const SHIKIMORI_API = 'https://shikimori.one/api/graphql';

// Подключение к MongoDB
let db;
async function connectToMongo() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    db = client.db('anime_db');
    fastify.log.info('Connected to MongoDB');
  } catch (error) {
    fastify.log.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// Поиск ID аниме по названию через GraphQL
async function findAnimeId(anime) {
  const searchTitles = [];
  
  if (anime.Title) searchTitles.push(anime.Title);
  if (anime.TitleEng) searchTitles.push(anime.TitleEng);
  if (anime.title) searchTitles.push(anime.title);
  
  if (searchTitles.length === 0) {
    fastify.log.warn('No title found for anime:', anime._id);
    return null;
  }
  
  const searchQuery = `
    query ($search: String) {
      animes(search: $search, limit: 5) {
        id
        name
        russian
      }
    }
  `;
  
  for (const title of searchTitles) {
    try {
      fastify.log.info(`Searching for: "${title}"`);
      
      const response = await axios.post(SHIKIMORI_API, {
        query: searchQuery,
        variables: { search: title }
      }, {
        headers: {
          'User-Agent': 'AnimeRatingUpdater',
          'Content-Type': 'application/json'
        }
      });

      const results = response.data.data?.animes;
      if (results && results.length > 0) {
        for (const result of results) {
          const resultRussian = result.russian?.toLowerCase() || '';
          const resultName = result.name?.toLowerCase() || '';
          const searchTitleLower = title.toLowerCase();
          
          if (resultRussian === searchTitleLower || resultName === searchTitleLower) {
            fastify.log.info(`Exact match found for "${title}" with ID: ${result.id}`);
            return result.id;
          }
        }
        
        fastify.log.info(`No exact match for "${title}", using best guess: ${results[0].russian || results[0].name} (ID: ${results[0].id})`);
        return results[0].id;
      }
      
      fastify.log.warn(`No results found for: "${title}"`);
    } catch (error) {
      fastify.log.error(`Shikimori search error for "${title}":`, error.message);
    }
    
    await delay(500);
  }
  
  return null;
}

// Получение детальной информации по ID через GraphQL
async function getShikimoriData(animeId) {
  const query = `
    query ($id: ID) {
      animes(ids: [$id]) {
        id
        score
        episodes
        status
        url
        genres {
          name
          russian
        }
        studios {
          name
        }
        externalLinks {
          kind
          url
        }
      }
    }
  `;

  try {
    const response = await axios.post(SHIKIMORI_API, {
      query,
      variables: { id: animeId }
    }, {
      headers: {
        'User-Agent': 'AnimeRatingUpdater',
        'Content-Type': 'application/json'
      }
    });

    const anime = response.data.data?.animes[0];
    if (anime) {
      return {
        score: anime.score,
        episodes: anime.episodes,
        status: anime.status,
        url: anime.url,
        genres: anime.genres.map(g => ({ name: g.name, russian: g.russian })),
        studios: anime.studios.map(s => s.name),
        externalLinks: anime.externalLinks.map(l => ({ kind: l.kind, url: l.url }))
      };
    }
    return null;
  } catch (error) {
    fastify.log.error(`Shikimori API error for ID ${animeId}:`, error.message);
    return null;
  }
}

// Функция задержки
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Функция обновления данных
async function updateRatings() {
  try {
    const stats = {
      total: 0,
      updated: 0,
      failed: 0,
      notFound: 0
    };
    
    const collection = db.collection('anime_list');
    const animeList = await collection.find({}).toArray();
    
    stats.total = animeList.length;
    fastify.log.info(`Found ${animeList.length} anime titles in database`);

    for (let i = 0; i < animeList.length; i++) {
      const anime = animeList[i];
      
      const animeId = await findAnimeId(anime);
      
      if (animeId) {
        const data = await getShikimoriData(animeId);
        
        if (data) {
          await collection.updateOne(
            { _id: anime._id },
            {
              $set: {
                imdbRating: data.score,
                Episodes: data.episodes,
                status: data.status,
                url: `https://shikimori.one${data.url}`,
                genres: data.genres,
                studios: data.studios,
                externalLinks: data.externalLinks,
                updatedAt: new Date()
              }
            }
          );
          stats.updated++;
          fastify.log.info(`[${i+1}/${animeList.length}] Updated: ${anime.Title || anime.TitleEng || anime.title}, score=${data.score}`);
        } else {
          stats.failed++;
          fastify.log.error(`[${i+1}/${animeList.length}] Failed to get data for: ${anime.Title || anime.TitleEng || anime.title} (ID: ${animeId})`);
        }          
      } else {
        stats.notFound++;
        fastify.log.warn(`[${i+1}/${animeList.length}] Anime not found on Shikimori: ${anime.Title || anime.TitleEng || anime.title}`);
      }
      
      if (i < animeList.length - 1) {
        await delay(1000);
      }
    }
    
    const report = `
=== ОБНОВЛЕНИЕ ЗАВЕРШЕНО ===
Всего обработано: ${stats.total} аниме
Успешно обновлено: ${stats.updated} (${Math.round(stats.updated/stats.total*100)}%)
Не найдено: ${stats.notFound} (${Math.round(stats.notFound/stats.total*100)}%)
Ошибки получения данных: ${stats.failed} (${Math.round(stats.failed/stats.total*100)}%)
============================
    `;
    
    fastify.log.info(report);
    return stats;
  } catch (error) {
    fastify.log.error('Error updating ratings:', error);
    return { error: error.message };
  }
}

// Endpoint для ручного запуска обновления
fastify.get('/update-ratings', async (request, reply) => {
  reply.send({ message: 'Ratings update started' });
  updateRatings().catch(err => fastify.log.error('Update error:', err));
});

// Endpoint для проверки статуса сервера
fastify.get('/health', async (request, reply) => {
  return { status: 'ok' };
});

// Запуск сервера
async function start() {
  try {
    await connectToMongo();

    cron.schedule('0 0 * * *', async () => {
      fastify.log.info('Starting scheduled ratings update');
      const stats = await updateRatings();
      fastify.log.info('Scheduled update completed', stats);
    });

    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Server listening on ${fastify.server.address().port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();