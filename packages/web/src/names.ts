// Names to offer someone who has never picked one: people from old stories and from
// history, all long out of copyright, one word each. Only a suggestion; the field stays editable.
const NAMES = [
  'Odysseus', 'Penelope', 'Circe', 'Antigone', 'Cassandra', 'Gilgamesh', 'Enkidu', 'Scheherazade', 'Sinbad',
  'Beowulf', 'Merlin', 'Lancelot', 'Guinevere', 'Quixote', 'Sancho', 'Dulcinea', 'Hamlet', 'Ophelia', 'Prospero',
  'Portia', 'Puck', 'Faust', 'Ahab', 'Ishmael', 'Queequeg', 'Nemo', 'Passepartout', 'Gulliver', 'Crusoe', 'Alice',
  'Sherlock', 'Watson', 'Darcy', 'Heathcliff', 'Wukong', 'Mulan', 'Zhuge', 'Genji', 'Murasaki', 'Kaguya', 'Momotaro',
  'Hypatia', 'Archimedes', 'Sappho', 'Cleopatra', 'Hannibal', 'Boudica', 'Ashoka', 'Saladin', 'Avicenna', 'Rumi',
  'Himiko', 'Tomoe', 'Musashi', 'Basho', 'Hokusai', 'Galileo', 'Kepler', 'Lovelace', 'Magellan',
]

export const randomName = (not?: string): string => {
  const pool = NAMES.filter((n) => n !== not)
  return pool[Math.floor(Math.random() * pool.length)]!
}
