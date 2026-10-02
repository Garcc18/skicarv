# Especificación de análisis — App de esquí tipo CARV

Oct 2, 2026 · @Ivan Garcia

## Resumen

La app analiza cada giro del esquiador con dos botas instrumentadas y le da feedback por audio al terminar cada giro, y un informe completo al final de cada bajada. Funciona en tres niveles de tiempo:

1. **Por giro (tiempo real, < 0,5 s tras acabar el giro):** detecta el giro, calcula sus métricas y, si toca, dice una frase o un número por los auriculares.
2. **Por bajada:** agrega los giros, separa izquierda y derecha, y muestra qué ha mejorado y qué no.
3. **Por sesión / temporada:** evolución de la puntuación global y de cada métrica.

Principios de diseño:

- **Cada métrica se basa en un estudio o en una técnica de esquí reconocida**, y se valida antes de enseñarla al usuario (ver *Validación*).
- **El giro es la unidad de análisis.** Todo se calcula por giro y luego se agrega, igual que CARV y que los estudios con sensores.
- **Pocas métricas, bien explicadas**, agrupadas en las cuatro habilidades clásicas del esquí: equilibrio, canteo, rotación y presión.
- **Un dato que falta no es un cero.** Si un sensor no tiene señal, sus métricas no se calculan en ese giro.
- **Primero que funcione en carving y giros largos**, que es donde los algoritmos con IMU son más fiables; los giros derrapados y la cuña vienen después.

## Sensores por bota

Las dos botas son iguales (IMU + 8 FSR a 100 Hz); la bota principal añade barómetro y GPS, que describen la bajada y no el pie, así que con uno basta.

| Sensor | Bota | Frecuencia | Para qué se usa |
| --- | --- | --- | --- |
| IMU (acelerómetro + giroscopio) | Ambas | 100 Hz | Detectar giros, orientación de la bota (inclinación lateral ≈ canteo), ritmo, fuerza G, rotación |
| 8 FSR | Ambas | 100 Hz | Reparto de presión delante/detrás, interior/exterior y entre esquí exterior e interior |
| Barómetro | Principal | 100 Hz (se usa filtrado a \~1 Hz) | Altitud y velocidad vertical: bajada, remonte, parada |
| GPS | Principal | 5 Hz | Velocidad, distancia, trazado de la bajada en el mapa, radio aproximado de giro |

**Dónde va la IMU:** en la parte trasera de la caña de la bota, como en los estudios de detección de giros de Martínez et al. (2019), que con esa posición validaron sus algoritmos. Mantener esa posición permite reutilizar sus métodos y resultados.

**Dónde van los 8 FSR (propuesta):** repartidos para separar las dos direcciones que importan, delante/detrás e interior/exterior del pie.

| FSR | Zona del pie | Grupo delante/detrás | Grupo interior/exterior |
| --- | --- | --- | --- |
| 1 | Talón, lado interior | Detrás | Interior |
| 2 | Talón, lado exterior | Detrás | Exterior |
| 3 | Mediopié exterior | Centro | Exterior |
| 4 | Cabeza del 5.º metatarsiano | Delante | Exterior |
| 5 | Cabezas del 2.º–3.º metatarsiano | Delante | Centro |
| 6 | Cabeza del 1.er metatarsiano | Delante | Interior |
| 7 | Dedo gordo | Delante | Interior |
| 8 | Dedos 2.º–5.º | Delante | Exterior |

El FSR 5 está donde los estudios con plantillas de presión sitúan el centro de presión en un giro conducido (bajo los metatarsianos 2–4), así que sirve de referencia de equilibrio. Ojo: una plantilla no mide toda la fuerza, porque parte se transmite por la caña de la bota (Nakazato et al., 2011). Las métricas de presión deben ser **relativas** (porcentajes y repartos), no fuerzas absolutas.

## Pipeline de procesado

El móvil hace todo el análisis en siete pasos por cada trama que llega, y al terminar cada bajada repite los pasos 2 a 6 sobre los datos grabados para el informe definitivo.

&#91;embedded content: pipeline de procesado · 7 pasos en directo + informe al final\]

- **Unir por seq:** las tramas de las dos botas con el mismo número de secuencia son del mismo instante (gracias a la sincronización por ESP-NOW). Sin esto no se pueden comparar las dos piernas.
- **Calibración:** ver *Validación y calibración*.
- **Orientación:** filtro de fusión (Madgwick o Mahony) que confía en el giroscopio durante el giro y corrige con el acelerómetro solo cuando la aceleración está cerca de 1 g.
- **Estado, giros y métricas:** secciones siguientes.
- **En directo vs. al final:** en directo los filtros son causales y añaden unas décimas de retraso, suficiente para dar feedback al acabar el giro; el informe usa filtros de fase cero sobre la bajada grabada.

## Bajadas, remontes y paradas

La app clasifica cada momento en *bajada*, *remonte* o *parada* combinando la velocidad vertical del barómetro, la velocidad del GPS y la actividad de la IMU. Solo se analizan giros y se da feedback dentro de una bajada.

El método sigue el de Martínez-Alvarez et al. (2020), que separaban esquí, remonte y pausa con umbrales de velocidad instantánea y diferencia de altitud, y una patente de detección de actividad de esquí que marca el remonte cuando la subida supera unos 0,4 m/s de forma sostenida (unos 25 s dentro de una ventana de 45 s).

| Estado | Cómo se detecta (valores iniciales a ajustar con datos reales) |
| --- | --- |
| Remonte | Velocidad vertical del barómetro > +0,4 m/s durante ≥ 25 s de una ventana de 45 s, y la IMU sin giros |
| Bajada | Velocidad vertical < −0,4 m/s **o** velocidad GPS > 10 km/h, y giros detectados por la IMU |
| Parada | Velocidad GPS < 3 km/h durante > 5 s y la IMU casi quieta |
| Fin de bajada | Parada > 30 s, o empieza un remonte |

Detalles importantes:

- **Filtrar el barómetro** con un paso bajo de \~0,5–1 Hz antes de derivar la velocidad vertical; a 100 Hz el ruido de presión es mucho mayor que la señal.
- **Usar altitud relativa dentro de cada bajada.** La presión atmosférica cambia con el tiempo, así que el barómetro deriva a lo largo del día; el desnivel de una bajada es fiable, la altitud absoluta no. Se puede recalibrar con la altitud del GPS en cada parada.
- **Por bajada se guarda:** duración, desnivel, distancia, velocidad media y máxima, número de giros e izquierda/derecha, y el trazado GPS.
- Los propios Martínez-Alvarez et al. vieron que la velocidad media y el tiempo de pausa ya separan bastante bien a esquiadores de distinto nivel; son buenas métricas de contexto, aunque no de técnica.

## Detección de giros

Un giro va de un **cambio de cantos** al siguiente, y el cambio de cantos se detecta como un extremo local de la velocidad angular de *roll* (inclinación lateral) de la bota. Es el método validado por Martínez et al. (2019) con una IMU en la caña de cada bota.

**Algoritmo (basado en ese estudio):**

1. Tomar el giroscopio de *roll* de cada bota (el eje delante-detrás de la bota, una vez orientada la IMU).
2. Filtrar a **0,5 Hz** (paso bajo Butterworth) para obtener una señal de decisión limpia: en ella cada giro es media onda.
3. Buscar extremos locales en esa señal como candidatos a cambio de cantos; descartar los de amplitud o duración demasiado pequeñas (ruido, baches).
4. Afinar el instante de cada cambio buscando el extremo en la misma señal filtrada a **3 Hz**, dentro de una ventana alrededor del candidato.
5. El lado del giro (izquierda o derecha) lo da el **signo del extremo** en el cambio de cantos que lo inicia, es decir, hacia qué lado rueda la bota en ese instante, y se comprueba con el signo de la inclinación de la bota en la conducción. El signo de la velocidad de *roll* entre dos cambios **no** sirve: esa señal pasa por cero en la inclinación máxima, a mitad del giro, así que cambia de signo dentro de cada giro.
6. Combinar ambas botas: el cambio de cantos del giro es el de la bota exterior del giro que empieza; la diferencia de tiempo entre las dos botas se guarda como métrica (ver *Métricas por giro*).

**Qué precisión cabe esperar**, según el estudio:

| Tipo de giro | Precisión | Sensibilidad (recall) |
| --- | --- | --- |
| Carving (374 giros) | 99,5 % | 99,5 % |
| Derrapado (132 giros) | 100 % | 83,3 % |
| Cuña (104 giros) | 83,9 % | 45,2 % |

En laboratorio, el instante del cambio de cantos tenía un error de unos ±0,03 s. En otro estudio de los mismos autores, con la IMU a 64 Hz, el giroscopio filtrado a 3 Hz dio la mejor precisión, unos 0,06 s. A 100 Hz estamos por encima de lo que ellos usaron.

**Fases del giro (propuesta):** a partir de la curva de inclinación de la bota, *inicio* va del cambio de cantos hasta que la inclinación llega al 50 % de su máximo; *conducción*, desde ahí hasta que vuelve a bajar del 50 %; *final*, hasta el siguiente cambio. Los estudios con plantillas usan fases parecidas (inicio y dos de conducción) y en ellas la presión pasa de la parte delantera del pie al talón a lo largo del giro (Falda-Buscaiot et al., 2017).

**Tiempo real vs. final de bajada:** en directo hay que usar filtros causales, que retrasan la señal unas décimas de segundo. Es aceptable, porque el feedback se da al acabar el giro. Al terminar la bajada, se vuelven a procesar todos los giros con filtrado de fase cero (sin retraso) para el informe definitivo.

**Limitación conocida:** la cuña y los giros muy derrapados se detectan mal con este método. Para principiantes hará falta un detector distinto, por ejemplo con la rotación (*yaw*) o con el reparto de presión entre pies.

## Métricas por giro (IMU)

Con una IMU por bota se pueden calcular las métricas de canteo y rotación que usa CARV, que agrupa sus 12 métricas en equilibrio, canteo, rotación y presión. Todas se calculan por giro, con la orientación de cada bota ya estimada (ver *Pipeline*).

| Métrica | Equivalente CARV | Qué mide | Cómo se calcula |
| --- | --- | --- | --- |
| Ángulo de canto | Edge Angle | Cuánto inclina el esquí contra la nieve | Máximo de la inclinación lateral (*roll*) de la bota respecto a la gravedad en la fase de conducción; la corrección por la pendiente queda para una versión posterior (ver abajo) |
| Canteo temprano | Early Edging | Si el canto se coge pronto en el giro | Tiempo desde el cambio de cantos hasta llegar al 50 % del ángulo máximo, en % de la duración del giro |
| Canteo progresivo | Progressive Edge Build | Si el canto aumenta de forma continua, sin saltos | Suavidad de la curva de *roll* en el inicio: saltos bruscos de la velocidad angular penalizan |
| Similitud de cantos | Edge Similarity | Si las dos botas cantean igual y a la vez | Diferencia de ángulo entre bota exterior e interior en conducción, y desfase entre los dos cambios de cantos |
| Esquís paralelos | Parallel Skis | Si los esquís abren en cuña | Diferencia de rumbo (*yaw*) entre las dos botas dentro del giro |
| Ritmo | — | Duración y regularidad de los giros | Tiempo entre cambios de cantos y su coeficiente de variación en la bajada |
| Radio de giro | Turn Shape (parcial) | Giro cerrado o abierto | Radio ≈ velocidad (GPS) / velocidad angular de rumbo (IMU) |
| Fuerza G | G-Force | Carga lateral del giro | Pico de la aceleración, filtrada, en conducción |
| Simetría | — | Diferencias entre giros a izquierda y derecha | Comparar cada métrica entre ambos lados en la bajada |

**El ángulo de canto es la métrica más delicada.** El ángulo de canto real es el ángulo entre la base del esquí y la nieve, y es el que más influye en el radio del giro. La IMU mide la inclinación de la bota respecto a la gravedad, no respecto a la nieve, y la caña de la bota no está perfectamente alineada con el esquí. Los estudios con IMU en la caña usan la inclinación de la pierna como aproximación del canto, con errores medios de entre −1,8° y 1,1° y una dispersión de 1° a 3,6°. Con una calibración específica, Hummel et al. (2024) llegaron a errores medios de unos 0,2° frente a captura de movimiento, aunque el error crecía con rotaciones rápidas.

Propuesta práctica: llamar a la métrica **«inclinación de la bota»** mientras no esté validada, medirla respecto a la gravedad y calibrar la posición neutra con el esquiador quieto de pie al empezar (ver *Validación*).

**La pendiente no se puede compensar con la inclinación media de la bajada.** Cuando el esquí no apunta por la línea de máxima pendiente, la ladera lo inclina lateralmente respecto a la gravedad unos atan(tan α · sen ψ), con α la pendiente y ψ el rumbo respecto a la línea de máxima pendiente. Ese término cambia de signo según el lado hacia el que se atraviesa la ladera, igual que la inclinación del giro. Por tanto:

- Respecto a la nieve, el canto es *mayor* que la inclinación medida en la parte del giro con el interior hacia arriba (después de la línea de máxima pendiente) y *menor* antes de ella.
- En una bajada con giros simétricos, la media de la inclinación sale cerca de 0 y no corrige nada.

Corregirlo bien exige α, a partir del barómetro y la distancia del GPS, y ψ, a partir del rumbo del GPS o de la IMU respecto a la dirección media de la bajada. Queda para después de validar la orientación; la v1 da la inclinación respecto a la gravedad.

**Orientación durante el giro:** en pleno giro el acelerómetro mide la gravedad más la fuerza centrípeta, así que no sirve solo para saber hacia dónde está la vertical. La orientación debe salir sobre todo de integrar el giroscopio, y corregirse con el acelerómetro solo en los momentos tranquilos (paradas, transiciones suaves). Un filtro de fusión estándar como Madgwick o Mahony, con la ganancia del acelerómetro reducida cuando la aceleración se aleja de 1 g, es el punto de partida.

## Métricas de presión (8 FSR por bota)

Los FSR permiten las métricas de equilibrio y presión, que son la mitad de lo que mide CARV. Todas usan **repartos relativos** (porcentajes), porque un FSR no mide fuerza absoluta con fiabilidad y parte de la carga va por la caña de la bota.

| Métrica | Equivalente CARV | Qué mide | Cómo se calcula |
| --- | --- | --- | --- |
| Presión en esquí exterior | Outside Ski Pressure | Si se carga el esquí exterior del giro | Presión total de la bota exterior / presión total de ambas botas, media en la fase de conducción |
| Transferencia de peso temprana | Early Weight Transfer | Si el peso pasa pronto al nuevo esquí exterior | Tiempo desde el cambio de cantos hasta que la bota exterior supera el 50 % de la presión total |
| Equilibrio delante/detrás | Fore:aft Ratio, Mid-Turn Balance | Si el esquiador va atrasado o adelantado | Posición del centro de presión a lo largo del pie (media de las posiciones de los FSR, pesada por su presión) |
| Movimiento adelante temprano | Early Forward Movement | Si va hacia delante al empezar el giro | Posición delante/detrás del centro de presión en la fase de inicio |
| Canto interior del pie | — | Si presiona con el borde interior del pie exterior | Reparto interior (FSR 1, 6, 7) frente a exterior (FSR 2, 3, 4, 8) en la bota exterior |
| Suavidad de presión | Pressure Smoothness | Si la carga crece y baja sin golpes | Variación brusca de la presión total en la conducción |
| Estabilidad del centro de presión | — | Cuánto se mueve el apoyo dentro del giro | Área o recorrido del centro de presión durante la conducción |

**Qué dicen los estudios** (y por tanto qué patrón se espera en un buen esquiador):

- El **pie exterior soporta mucha más fuerza** y es el que gira el esquí; el interior sirve sobre todo para la estabilidad (Falda-Buscaiot et al., 2017, con plantillas de presión en gigante).
- A lo largo del giro, la carga **pasa de la parte delantera del pie al talón**: delante al iniciar, detrás al final de la conducción. El patrón cambia con la pendiente, y en zonas empinadas la fuerza es mayor (mismo estudio).
- En un giro conducido, el centro de presión se mantiene **bajo los metatarsianos 2–4** y se mueve en un área **mucho más pequeña** que en un giro derrapado (estudio de 2007 con plantillas de 24 sensores a 200 Hz y esquiadores del equipo nacional finlandés).

Esto da dos reglas útiles para el feedback: un centro de presión que se queda en el talón al empezar el giro indica que el esquiador va atrasado; y un centro de presión que se mueve mucho indica derrape o desequilibrio.

**Calibración necesaria de los FSR:**

1. **Cero:** lectura de cada FSR sin carga (bota en el aire) al encender.
2. **Referencia:** 5 s de pie, quieto, con el peso repartido en ambos pies. Todas las presiones se expresan como fracción de esa referencia.
3. **Revisar la deriva:** los FSR cambian su lectura con la temperatura y con el uso, así que conviene repetir la referencia en cada parada larga.

## Puntuación y feedback en tiempo real

El feedback se da **por audio, al acabar cada giro, sobre una sola cosa a la vez**, y se va retirando a medida que el esquiador mejora. Así lo hace CARV en su modo Monitor, y es lo que recomienda la investigación sobre aprendizaje motor.

**Qué hace CARV:** combina sus 12 métricas en una puntuación global, Ski:IQ. En su modo Monitor el usuario elige una métrica (por ejemplo, canteo temprano, presión exterior o equilibrio delante/detrás) y recibe su puntuación por los auriculares después de cada giro, para poder probar y corregir sobre la marcha.

**Qué dice la investigación sobre feedback** (revisión de Sigrist et al., 2013):

- En tareas complejas como el esquí, el feedback inmediato ayuda sobre todo al principio del aprendizaje.
- Si se da siempre, el esquiador se vuelve dependiente de él y rinde peor sin él. Conviene **reducirlo con el tiempo** e incluir tramos sin feedback.
- El **feedback por umbral** (solo cuando el error supera un margen) ayuda a repetir lo que sale bien.
- Dejar que el usuario **pida el feedback** funciona mejor que un calendario fijo.
- El **audio** evita la sobrecarga visual, y en esquí además es lo único práctico.

**Puntuación propuesta:**

1. Cada métrica de un giro se convierte en una nota de 0 a 100 comparándola con un rango de referencia por nivel. Esos rangos hay que sacarlos de datos de esquiadores buenos grabados con el propio sistema (ver *Validación*).
2. La nota del giro es la media de las métricas disponibles en ese giro; las de sensores sin señal no cuentan.
3. La nota de la bajada es la **mediana** de las notas de sus giros, para que un giro malo aislado no la hunda.
4. Pesos iguales al principio. Cuando haya datos, ajustarlos según qué métricas separan mejor a esquiadores de distinto nivel.

**Modos de feedback en pista:**

| Modo | Qué dice | Cuándo |
| --- | --- | --- |
| Monitor | La nota de la métrica elegida | Después de cada giro |
| Entrenador | Una frase corta sobre el foco de la bajada («más peso fuera», «adelante al empezar») | Solo si la métrica sale de su rango; también cuando un giro sale bien; cada vez menos a medida que mejora |
| Silencioso | Nada en pista; resumen hablado en la parada | Al parar o al subir al remonte |

Reglas: nunca hablar en mitad de un giro; mensajes de menos de 2 s; como mucho un mensaje cada dos o tres giros en modo Entrenador; y el informe detallado (gráficas, izquierda contra derecha, evolución) en el remonte, con la pantalla.

## Validación y calibración

Ninguna métrica se enseña al usuario hasta haberla comparado con una referencia independiente. Las pruebas, de la más sencilla a la más completa:

| Qué se valida | Prueba | Criterio para darla por buena |
| --- | --- | --- |
| Sincronización entre botas | Golpear las dos botas entre sí: el pico de aceleración debe salir en el mismo instante en ambas | Diferencia ≤ 1 muestra (10 ms) |
| Presión (estático) | De pie sobre un pie; inclinarse adelante y atrás | 100 % en la bota cargada; el centro de presión se mueve en el sentido correcto |
| Ángulo de la bota (estático) | Inclinar la bota a ángulos conocidos con un inclinómetro | Error de pocos grados, comparable a los estudios (−1,8° a 1,1° de error medio) |
| Detección de giros | Grabar bajadas en vídeo y contar a mano los cambios de cantos | En carving, cerca del 99 % de los giros detectados, como en Martínez et al. (2019) |
| Ángulo de canto (en pista) | Vídeo desde detrás o desde abajo, midiendo la inclinación en momentos concretos | Error del orden de los estudios; si no, la métrica se queda como «inclinación de la bota» |
| Bajadas y remontes | Comparar con lo que el esquiador apunta (o con el mapa de remontes) | Ninguna bajada partida ni remonte confundido con bajada |
| Utilidad de las métricas | Grabar esquiadores de nivel conocido (monitores, nivel medio, principiantes) | Cada métrica separa los niveles; si no lo hace, no entra en la puntuación |

La última prueba es la más importante: con esos datos se fijan los **rangos de referencia** de la puntuación. Sin ellos, cualquier nota de 0 a 100 sería inventada.

**Calibración en cada uso** (unos 10 s al empezar el día):

1. Botas en el aire: cero de los FSR.
2. De pie y quieto, esquís paralelos en llano: posición neutra de la IMU (vertical de la bota) y referencia de presión.
3. Opcional: un par de flexiones de rodilla para identificar el eje delante/detrás de la bota, por si la IMU no va montada perfectamente alineada.

## Plan de desarrollo

La clave es **grabar datos reales antes de escribir los algoritmos en la app**: todos los métodos de este documento se desarrollan y validan primero offline, en Python, sobre bajadas grabadas, y solo después se pasan a tiempo real.

1. **Base (hecho):** enlace BLE, GATT, tramas a 100 Hz, página de prueba con datos simulados.
2. **Firmware definitivo:** cada bota con IMU + 8 FSR; la principal con barómetro y GPS; sincronización entre botas por ESP-NOW; calibración al arrancar.
3. **Grabación:** la app guarda todas las tramas crudas de ambas botas en un archivo por bajada, con vídeo opcional del móvil para validar.
4. **Algoritmos offline (Python):** orientación de la bota, detección de bajadas y de giros. Validar contra vídeo (ver *Validación*).
5. **Métricas offline:** métricas de IMU y de presión; grabar esquiadores de distintos niveles y fijar los rangos de referencia.
6. **Tiempo real en la app:** pasar los algoritmos validados a la app y empezar con el modo Monitor (una métrica por giro, por audio).
7. **Puntuación e informes:** nota por giro y bajada, modo Entrenador con feedback que se va retirando, informe en el remonte.

Todo el análisis va en el móvil, no en las botas: las botas solo miden, sincronizan y envían. Así los algoritmos se pueden cambiar sin tocar el firmware.

## Referencias

- Martínez Álvarez, A., Brunauer, R., Venek, V., Snyder, C., Jahnel, R., Buchecker, M., Thorwartl, C. y Stöggl, T. (2019). [Development and Validation of a Gyroscope-Based Turn Detection Algorithm for Alpine Skiing in the Field](https://www.frontiersin.org/articles/10.3389/fspor.2019.00018/full). *Frontiers in Sports and Active Living*, 1:18.
- Martínez, A., Jahnel, R., Buchecker, M., Snyder, C., Brunauer, R. y Stöggl, T. (2019). [Development of an Automatic Alpine Skiing Turn Detection Algorithm Based on a Simple Sensor Setup](https://www.mdpi.com/1424-8220/19/4/902). *Sensors*, 19(4), 902.
- Martinez-Alvarez, A., Snyder, C., Neuwirth, C. y Stöggl, T. (2020). [Classification of alpine skiers skill level using smartphone data](https://salzburgresearch.at/?p=35534). Salzburg Research.
- [Validation of a wearable system for edge angle estimation during alpine skiing](https://lida.sport-iat.de/svd/Record/4064053?lng=en) (2020). *Science and Skiing VIII*, Universidad de Jyväskylä.
- Hummel, Huber y Spitzenpfeil (2024). [Estimating ski orientation using IMUs in alpine skiing](https://doaj.org/article/5eee6fd637cc4a8fbde28ac1abb2b53d). *Current Issues in Sport Science*.
- Falda-Buscaiot, T., Hintzy, F., Rougier, P., Lacouture, P. y Coulmy, N. (2017). [Influence of slope steepness, foot position and turn phase on plantar pressure distribution during giant slalom alpine ski racing](https://ideas.repec.org/a/plo/pone00/0176975.html). *PLOS ONE*.
- Nakazato, K., Scheiber, P. y Müller, E. (2011). [Comparación de placas de fuerza y plantillas de presión en esquí alpino](https://jssm.org/10-4-754.p_d_f). *Journal of Sports Science and Medicine*.
- [Ground reaction force and centre of pressure in alpine skiing carved turn](https://lida.sport-iat.de/ta/Record/3042864) (2007). Universidad de Salzburgo.
- Sigrist, R., Rauter, G., Riener, R. y Wolf, P. (2013). [Augmented visual, auditory, haptic, and multimodal feedback in motor learning: a review](https://www.doi.org/10.3758/S13423-012-0333-8). *Psychonomic Bulletin & Review*.
- Patente US 2019/0076063, [Systems and methods of ski activity detection](https://patents.justia.com/patent/20190076063).
- CARV: [How Carv turns your skiing into data](https://getcarv.com/blog/how-carv-turns-your-skiing-into-data) y [Monitor mode](https://getcarv.com/blog/why-we-created-turn-skiiq-monitor).
